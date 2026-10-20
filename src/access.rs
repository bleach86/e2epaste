//! Opening, downloading and deleting pastes.
//!
//! The paste page itself (/paste/<id>) holds no paste data. The browser
//! derives an access proof from the full link (and password) and sends it to
//! /api/open/<id>, which checks it against the stored hash, counts the view
//! and only then returns the encrypted paste. So knowing a paste's ID isn't
//! enough to download it or use up its views, and a wrong password doesn't use
//! a view.

use std::sync::Arc;

use rocket::fs::NamedFile;
use rocket::http::Status;
use rocket::request::{self, FromRequest, Request};
use rocket::serde::json::Json;
use rocket::State;
use rocket_dyn_templates::{context, Template};
use serde::{Deserialize, Serialize};

use crate::api::{ApiError, ClientIp};
use crate::config::AppConfig;
use crate::paste_db::{Opened, PasteDB, PasteData};
use crate::paste_id::PasteId;
use crate::rate_limit::UnlockLimiter;
use crate::secrets;
use crate::tickets::DownloadTickets;

/// What the paste page gets before the paste is opened: enough to derive the
/// key and show the paste's details, but none of its encrypted content.
#[derive(Serialize)]
pub struct PastePublic<'a> {
    pub id: String,
    pub version: u32,
    pub iv: &'a [u8],
    pub has_password: bool,
    pub syntax: &'a str,
    pub timestamp: i64,
    pub expires: Option<u64>,
    pub views: u64,
    pub max_views: Option<u64>,
    pub has_attachment: bool,
    /// v1 and v2 titles were stored unencrypted.
    pub title: Option<&'a str>,
}

impl<'a> PastePublic<'a> {
    pub fn new(paste: &'a PasteData<'_>) -> Self {
        PastePublic {
            id: paste.id.to_string(),
            version: paste.version,
            iv: &paste.iv,
            // v1 pastes stored a password hash instead of the flag.
            has_password: paste.has_password || paste.password_hash.is_some(),
            syntax: &paste.syntax,
            timestamp: paste.timestamp,
            expires: paste.expires,
            views: paste.views,
            max_views: paste.max_views,
            has_attachment: paste.file_name.is_some(),
            title: (paste.version < 3).then_some(paste.title.as_str()),
        }
    }
}

#[derive(Deserialize)]
pub struct OpenRequest {
    /// Hex. Pastes from before access proofs don't need one.
    #[serde(default)]
    proof: Option<String>,
}

#[derive(Serialize)]
pub struct OpenResponse {
    content: String,
    title: String,
    file_name: Option<String>,
    key_fragment: String,
    views: u64,
    total_views: u64,
    /// This was the last allowed view: the paste is gone (an attachment can
    /// still be downloaded for a while).
    last_view: bool,
    /// For /api/download-attachment, if the paste has an attachment.
    download_ticket: Option<String>,
}

#[post("/api/open/<id>", format = "application/json", data = "<request>")]
pub fn open(
    db: &State<Arc<PasteDB>>,
    unlocks: &State<UnlockLimiter>,
    tickets: &State<Arc<DownloadTickets>>,
    client: ClientIp,
    id: PasteId<'_>,
    request: Json<OpenRequest>,
) -> Result<Json<OpenResponse>, ApiError> {
    let id = id.to_string();
    // Too many wrong links or passwords from this IP.
    unlocks.0.check(client.0).map_err(ApiError::RateLimited)?;

    match db.open_paste(&id, request.proof.as_deref()) {
        Ok(Opened::Paste { paste, total_views, last_view }) => {
            let download_ticket = paste.file_name.is_some().then(|| tickets.issue(&id));
            Ok(Json(OpenResponse {
                content: paste.content,
                title: paste.title,
                file_name: paste.file_name,
                key_fragment: paste.key_fragment,
                views: paste.views,
                total_views,
                last_view,
                download_ticket,
            }))
        }
        Ok(Opened::NotFound) => Err(Status::NotFound.into()),
        Ok(Opened::WrongProof) => {
            let _ = unlocks.0.take(client.0, 0);
            Err(Status::Forbidden.into())
        }
        Err(e) => {
            eprintln!("Error opening paste {id}: {e}");
            Err(Status::InternalServerError.into())
        }
    }
}

#[get("/api/download-attachment/<id>")]
pub async fn download_attachment(
    db: &State<Arc<PasteDB>>,
    tickets: &State<Arc<DownloadTickets>>,
    id: PasteId<'_>,
    ticket: DownloadTicket,
) -> Result<NamedFile, Status> {
    let id = id.to_string();
    if !tickets.is_valid(&ticket.0, &id) {
        return Err(Status::Forbidden);
    }
    let file = NamedFile::open(db.attachment_path(&id)).await.map_err(|_| Status::NotFound)?;

    // A used-up paste was only kept for this download. The file is already
    // open, so it can still be sent after it's deleted.
    if db.get_paste(&id).is_some_and(|paste| paste.used_up()) {
        if let Err(e) = db.delete_paste(&id).await {
            eprintln!("Error deleting paste {id}: {e}");
        }
    }
    Ok(file)
}

// --- Deleting ---------------------------------------------------------------

/// The page the creator's delete link opens. The token is in the link's
/// hash, so the browser sends it with the request (and it never reaches logs
/// as part of a URL).
#[get("/delete/<id>")]
pub fn delete_page(db: &State<Arc<PasteDB>>, id: PasteId<'_>) -> Template {
    Template::render(
        "delete",
        context! {
            title: crate::TITLE,
            page: crate::DELETE_PAGE,
            paste_id: id.to_string(),
            site_stats: db.get_site_stats(),
            year: chrono::Datelike::year(&chrono::Utc::now()),
        },
    )
}

#[post("/api/delete/<id>")]
pub async fn delete(
    db: &State<Arc<PasteDB>>,
    unlocks: &State<UnlockLimiter>,
    client: ClientIp,
    id: PasteId<'_>,
    token: DeleteToken,
) -> Result<Json<serde_json::Value>, ApiError> {
    let id = id.to_string();
    unlocks.0.check(client.0).map_err(ApiError::RateLimited)?;

    let paste = db.get_paste(&id).ok_or(Status::NotFound)?;
    let authorized = paste
        .delete_hash
        .as_deref()
        .is_some_and(|hash| secrets::matches_hash(&token.0, hash));
    if !authorized {
        let _ = unlocks.0.take(client.0, 0);
        return Err(Status::Forbidden.into());
    }

    db.delete_paste(&id).await.map_err(|e| {
        eprintln!("Error deleting paste {id}: {e}");
        ApiError::Status(Status::InternalServerError)
    })?;
    Ok(Json(serde_json::json!({"deleted": true})))
}

/// For the site's operator, e.g. to take down a reported paste. Needs
/// `admin_token` to be set; otherwise it doesn't exist.
#[post("/api/admin/delete/<id>")]
pub async fn admin_delete(
    db: &State<Arc<PasteDB>>,
    config: &State<AppConfig>,
    unlocks: &State<UnlockLimiter>,
    client: ClientIp,
    id: PasteId<'_>,
    auth: BearerToken,
) -> Result<Json<serde_json::Value>, ApiError> {
    let id = id.to_string();
    let Some(admin_token) = &config.admin_token else {
        return Err(Status::NotFound.into());
    };
    unlocks.0.check(client.0).map_err(ApiError::RateLimited)?;
    if !secrets::constant_time_eq(auth.0.as_bytes(), admin_token.as_bytes()) {
        let _ = unlocks.0.take(client.0, 0);
        return Err(Status::Forbidden.into());
    }

    let existed = db.paste_exists(&id).map_err(|e| {
        eprintln!("Error reading paste {id}: {e}");
        ApiError::Status(Status::InternalServerError)
    })?;
    db.delete_paste(&id).await.map_err(|e| {
        eprintln!("Error deleting paste {id}: {e}");
        ApiError::Status(Status::InternalServerError)
    })?;
    if existed {
        println!("Admin deleted paste {id}");
    }
    Ok(Json(serde_json::json!({"deleted": existed})))
}

// --- Request headers ----------------------------------------------------------

macro_rules! header_guard {
    ($(#[$doc:meta])* $name:ident, $header:literal) => {
        $(#[$doc])*
        pub struct $name(pub String);

        #[rocket::async_trait]
        impl<'r> FromRequest<'r> for $name {
            type Error = ();

            async fn from_request(req: &'r Request<'_>) -> request::Outcome<Self, ()> {
                match req.headers().get_one($header) {
                    Some(value) => request::Outcome::Success($name(value.to_string())),
                    None => request::Outcome::Error((Status::Forbidden, ())),
                }
            }
        }
    };
}

header_guard!(
    /// The X-Download-Ticket header.
    DownloadTicket,
    "X-Download-Ticket"
);
header_guard!(
    /// The X-Delete-Token header.
    DeleteToken,
    "X-Delete-Token"
);

/// The token from an `Authorization: Bearer <token>` header.
pub struct BearerToken(pub String);

#[rocket::async_trait]
impl<'r> FromRequest<'r> for BearerToken {
    type Error = ();

    async fn from_request(req: &'r Request<'_>) -> request::Outcome<Self, ()> {
        let token = req
            .headers()
            .get_one("Authorization")
            .and_then(|value| value.strip_prefix("Bearer "));
        match token {
            Some(token) => request::Outcome::Success(BearerToken(token.trim().to_string())),
            None => request::Outcome::Error((Status::Unauthorized, ())),
        }
    }
}
