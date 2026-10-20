#[macro_use]
extern crate rocket;

mod api;
mod assets;
mod config;
mod paste_db;
mod paste_id;
mod rate_limit;
mod tools;

use rocket::data::ToByteUnit;
use rocket::fairing::Fairing;
use rocket::fs::{FileServer, NamedFile};
use rocket::http::ContentType;
use rocket::http::Header;
use rocket::http::Status;
use rocket::request::Request;
use rocket::response::Response;
use rocket::serde::json::Json;
use rocket::tokio;
use rocket::State;
use rocket::{post, Data};
use rocket_dyn_templates::{context, Template};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;

use chrono::prelude::*;

use api::{ApiError, ClientIp};
use config::{AppConfig, MAX_ATTACHMENT_MIB, MIB};
use rate_limit::RateLimiter;
use paste_db::{PasteDB, PasteData};
use paste_id::PasteId;

const TITLE: &str = "e2ePaste.XYZ";
const ID_LENGTH: usize = 8;

/// Per-page <title>, meta description and link-preview text, rendered by
/// layout.html.j2.
#[derive(Serialize)]
pub struct PageMeta {
    pub title: &'static str,
    pub description: &'static str,
    /// Path for the canonical URL and og:url. `None` marks the page noindex.
    pub canonical: Option<&'static str>,
}

const INDEX_PAGE: PageMeta = PageMeta {
    title: "e2ePaste.XYZ - End-to-End Encrypted Pastebin",
    description: "Share text and files with end-to-end encryption. Pastes are encrypted in your browser \
        with AES-256-GCM, with optional passwords, expiry and view limits.",
    canonical: Some("/"),
};

const FAQ_PAGE: PageMeta = PageMeta {
    title: "FAQ - e2ePaste.XYZ",
    description: "How e2ePaste.XYZ encrypts pastes in your browser so the server can't read them, what \
        the server can see, how passwords, expiry and view limits work, and size limits.",
    canonical: Some("/faq"),
};

const CREDITS_PAGE: PageMeta = PageMeta {
    title: "Open Source Credits - e2ePaste.XYZ",
    description: "The open source projects e2ePaste.XYZ is built on, with their licences.",
    canonical: Some("/credits"),
};

// Paste pages are private: never indexed, and generic preview text so shared
// links don't reveal anything about the paste.
const PASTE_PAGE: PageMeta = PageMeta {
    title: "Encrypted Paste - e2ePaste.XYZ",
    description: "An end-to-end encrypted paste. It can only be decrypted in your browser using the \
        full link.",
    canonical: None,
};

const NOT_FOUND_PAGE: PageMeta = PageMeta {
    title: "Paste Not Found - e2ePaste.XYZ",
    description: "This paste doesn't exist, has expired, or has reached its view limit.",
    canonical: None,
};

// Pages listed in sitemap.xml, besides the tool pages.
const SITEMAP_PATHS: [&str; 3] = ["/", "/faq", "/credits"];

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct IncomingPaste {
    pub content: String,
    pub iv: Vec<u8>,
    pub expires: Option<u64>,
    pub max_views: Option<u64>,
    pub key_fragment: String,
    // Only sent by v1 clients. v2 never sends a password hash.
    #[serde(default)]
    pub password_hash: Option<String>,
    #[serde(default)]
    pub has_password: bool,
    #[serde(default = "paste_db::legacy_version")]
    pub version: u32,
    pub title: String,
    pub syntax: String,
    pub file_name: Option<String>,
    /// Size of the encrypted attachment that will be uploaded. Older clients
    /// don't send it; they're allowed the maximum.
    #[serde(default)]
    pub file_size: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct IncomingPasteRes {
    pub id: Option<String>,
    /// Only for pastes with an attachment: the one-time token for
    /// /api/upload-attachment.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upload_token: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DownloadAttachmentRes {
    pub error: Option<String>,
    pub file: Option<Vec<u8>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AdvanceViewsRes {
    pub error: Option<String>,
    pub views: Option<u64>,
    pub total_views: Option<u64>,
}

struct CacheControlFairing;

#[rocket::async_trait]
impl Fairing for CacheControlFairing {
    fn info(&self) -> rocket::fairing::Info {
        rocket::fairing::Info {
            name: "Cache Control Fairing",
            kind: rocket::fairing::Kind::Response,
        }
    }

    async fn on_response<'r>(&self, request: &'r Request<'_>, response: &mut Response<'r>) {
        if request.uri().path().starts_with("/public/") {
            response.set_header(Header::new("Cache-Control", "public, max-age=15552000"));
        }
    }
}

pub struct WasmFairing;

#[rocket::async_trait]
impl Fairing for WasmFairing {
    fn info(&self) -> rocket::fairing::Info {
        rocket::fairing::Info {
            name: "Wasm MIME Type Setter",
            kind: rocket::fairing::Kind::Response,
        }
    }

    async fn on_response<'r>(&self, _req: &'r Request<'_>, res: &mut Response<'r>) {
        if let Some(path) = _req.uri().path().split('/').last() {
            if path.ends_with(".wasm") {
                println!("Path: {:?}", path);
                res.set_header(ContentType::new("application", "wasm"));
            }
        }
    }
}

#[post("/api/submit_paste", format = "application/json", data = "<raw_paste>")]
async fn upload(
    db: &State<Arc<PasteDB>>,
    config: &State<AppConfig>,
    limiter: &State<Arc<RateLimiter>>,
    client: ClientIp,
    raw_paste: Json<IncomingPaste>,
) -> Result<Json<IncomingPasteRes>, ApiError> {
    let paste: IncomingPaste = raw_paste.clone().into_inner();

    // The attachment's size is checked and charged now, so a paste is never
    // created whose attachment would then be refused.
    let max_attachment = MAX_ATTACHMENT_MIB * MIB;
    let attachment_bytes: u64 = match (&paste.file_name, paste.file_size) {
        (None, _) => 0,
        (Some(_), Some(size)) if size > max_attachment => return Err(Status::PayloadTooLarge.into()),
        (Some(_), Some(size)) => size,
        (Some(_), None) => max_attachment,
    };
    api::check_storage(db, config, attachment_bytes)?;
    limiter.take(client.0, attachment_bytes).map_err(ApiError::RateLimited)?;

    let id: PasteId<'_> = loop {
        // Generate a new paste ID until we find one that isn't already in use.
        let id: PasteId<'_> = PasteId::new(ID_LENGTH);
        if db.get_paste(id.to_string()).is_none() {
            break id;
        }
    };
    let now: DateTime<Utc> = Utc::now();

    let expires = match paste.expires {
        Some(expires) => Some(expires),
        None => Some(
            now.timestamp_millis() as u64
                + (Duration::from_secs(60 * 60 * 24 * 365).as_millis() as u64),
        ),
    };

    let paste_data: PasteData = PasteData {
        content: paste.content,
        iv: paste.iv,
        key_fragment: paste.key_fragment,
        id: id.clone(),
        timestamp: now.timestamp(),
        expires,
        views: 0,
        max_views: paste.max_views,
        has_password: paste.has_password || paste.password_hash.is_some(),
        password_hash: paste.password_hash,
        version: paste.version,
        title: paste.title,
        syntax: paste.syntax,
        file_name: paste.file_name,
    };

    let failed = Ok(Json(IncomingPasteRes { id: None, upload_token: None }));

    // The token goes in first, so it exists by the time the paste does.
    let upload_token: Option<String> = if paste_data.file_name.is_some() {
        let token = new_upload_token();
        if let Err(e) = db.set_upload_token(&id.to_string(), &token, attachment_bytes) {
            eprintln!("Error saving upload token: {:?}", e);
            return failed;
        }
        Some(token)
    } else {
        None
    };

    match db.set_paste(&paste_data) {
        Ok(_) => {
            match db.increment_pastes() {
                Ok(_) => {}
                Err(e) => {
                    eprintln!("Error incrementing pastes: {:?}", e);
                }
            };
            Ok(Json(IncomingPasteRes {
                id: Some(id.to_string()),
                upload_token,
            }))
        }
        Err(e) => {
            eprintln!("Error saving paste: {:?}", e);
            failed
        }
    }
}

/// 256 random bits, hex encoded.
fn new_upload_token() -> String {
    let bytes: [u8; 32] = rand::random();
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The X-Upload-Token header.
struct UploadToken(String);

#[rocket::async_trait]
impl<'r> rocket::request::FromRequest<'r> for UploadToken {
    type Error = ();

    async fn from_request(req: &'r Request<'_>) -> rocket::request::Outcome<Self, ()> {
        match req.headers().get_one("X-Upload-Token") {
            Some(token) => rocket::request::Outcome::Success(UploadToken(token.to_string())),
            None => rocket::request::Outcome::Error((Status::Forbidden, ())),
        }
    }
}

#[post("/api/advance-views/<id>")]
async fn advance_views(db: &State<Arc<PasteDB>>, id: PasteId<'_>) -> Json<AdvanceViewsRes> {
    let mut paste_data: PasteData = match db.get_paste(id.to_string()) {
        Some(paste_data) => paste_data,
        None => {
            return Json(AdvanceViewsRes {
                error: Some("Paste not found".to_string()),
                views: None,
                total_views: None,
            })
        }
    };

    paste_data.views += 1;

    if let Some(max_views) = paste_data.max_views {
        if paste_data.views >= max_views {
            match paste_data.expires {
                Some(expires) => match db.delete_expired_index(expires) {
                    Ok(_) => {}
                    Err(e) => {
                        eprintln!("Error deleting expired index: {:?}", e);
                    }
                },
                None => {}
            }

            let now: DateTime<Utc> = Utc::now();
            let twelve_hours_from_now = now + chrono::Duration::hours(12);

            paste_data.expires = Some(twelve_hours_from_now.timestamp_millis() as u64);
        }
    }

    match db.increment_views() {
        Ok(_) => {}
        Err(e) => {
            eprintln!("Error incrementing views: {:?}", e);
        }
    };

    match db.set_paste(&paste_data) {
        Ok(_) => {}
        Err(e) => {
            eprintln!("Error saving paste: {:?}", e);
        }
    };

    let site_stats: paste_db::SiteStats = db.get_site_stats();

    Json(AdvanceViewsRes {
        error: None,
        views: Some(paste_data.views),
        total_views: Some(site_stats.views),
    })
}

// /s/ is the short form handed out for new pastes.
#[get("/s/<id>")]
async fn share_short(id: PasteId<'_>, db: &State<Arc<PasteDB>>) -> Template {
    filter_bots(id, db).await
}

#[get("/share/<id>")]
async fn filter_bots(id: PasteId<'_>, db: &State<Arc<PasteDB>>) -> Template {
    let site_stats: paste_db::SiteStats = db.get_site_stats();
    Template::render(
        "bot_filter",
        context! {title: TITLE, page: PASTE_PAGE, paste_id: id.to_string(), site_stats, year: Utc::now().year()},
    )
}

#[post("/api/upload-attachment/<id>", data = "<data>")]
async fn upload_attachment(
    db: &State<Arc<PasteDB>>,
    config: &State<AppConfig>,
    data: Data<'_>,
    id: PasteId<'_>,
    token: UploadToken,
) -> Result<&'static str, ApiError> {
    let id = id.to_string();
    let internal = |e: &dyn std::fmt::Debug| {
        eprintln!("Error saving attachment for {id}: {e:?}");
        ApiError::Status(Status::InternalServerError)
    };

    // Only the paste's creator has the token, and only until an upload
    // succeeds. It's removed when the paste is deleted, so this also checks
    // the paste exists.
    // The size limit was set (and charged to the client's allowance) when the
    // paste was created.
    let max_bytes = match db.upload_allowance(&id, &token.0).map_err(|e| internal(&e))? {
        Some(max_bytes) => max_bytes,
        None => return Err(Status::Forbidden.into()),
    };
    // Only the free-space check: the attachment already counts towards the
    // storage cap from when the paste was created.
    api::check_storage(db, config, 0)?;

    // Written to a temporary file, so a failed upload can be retried and never
    // leaves a partial attachment.
    let partial = db.partial_upload_path(&id);
    // One byte over the limit is read so a body of exactly `max_bytes` ends
    // inside it: Rocket logs "Data limit reached" whenever a read uses up the
    // limit, even when the body ends there.
    let written = match data.open((max_bytes + 1).bytes()).into_file(&partial).await {
        Ok(written) => written,
        Err(e) => {
            let _ = tokio::fs::remove_file(&partial).await;
            return Err(internal(&e));
        }
    };
    if !written.is_complete() || written.n.written > max_bytes {
        let _ = tokio::fs::remove_file(&partial).await;
        return Err(Status::PayloadTooLarge.into());
    }

    // Of concurrent uploads with the right token, only one gets past here.
    match db.consume_upload_token(&id, &token.0) {
        Ok(true) => {}
        Ok(false) => {
            let _ = tokio::fs::remove_file(&partial).await;
            return Err(Status::Forbidden.into());
        }
        Err(e) => {
            let _ = tokio::fs::remove_file(&partial).await;
            return Err(internal(&e));
        }
    }
    let path = db.attachment_path(&id);
    if let Err(e) = tokio::fs::rename(&partial, &path).await {
        let _ = tokio::fs::remove_file(&partial).await;
        return Err(internal(&e));
    }
    db.add_attachment_bytes(written.n.written);

    // The paste may have expired while the file was uploading. Deleting it
    // again also takes the file off the storage total.
    if db.get_paste(id.clone()).is_none() {
        let _ = db.delete_paste(id.clone()).await;
        return Err(Status::NotFound.into());
    }
    Ok("Upload successful")
}
#[get("/api/download-attachment/<id>")]
async fn download_attachment(db: &State<Arc<PasteDB>>, id: PasteId<'_>) -> Option<NamedFile> {
    NamedFile::open(db.attachment_path(&id.to_string())).await.ok()
}

#[get("/paste/<id>")]
async fn retrieve(db: &State<Arc<PasteDB>>, id: &str) -> (Status, Template) {
    let site_stats: paste_db::SiteStats = db.get_site_stats();
    let now: DateTime<Utc> = chrono::Utc::now();

    let mut paste_data: PasteData = match db.get_paste(id.to_string()) {
        Some(paste_data) => paste_data,
        None => {
            return paste_not_found(site_stats, now.year());
        }
    };

    // Never send the password hash to the browser. A wrong password fails to
    // decrypt, so the page only needs to know whether to ask for one.
    let has_password: bool = paste_data.has_password || paste_data.password_hash.is_some();
    paste_data.password_hash = None;

    let views: u64 = paste_data.views + 1;

    if let Some(max_views) = paste_data.max_views {
        if views > max_views {
            println!("Deleting paste with ID: {}", id);
            match db.delete_paste(id.to_string()).await {
                Ok(_) => {}
                Err(e) => {
                    eprintln!("Error deleting paste: {:?}", e);
                }
            };
            match paste_data.expires {
                Some(expires) => match db.delete_expired_index(expires) {
                    Ok(_) => {}
                    Err(e) => {
                        eprintln!("Error deleting expired index: {:?}", e);
                    }
                },
                None => {}
            }
            return paste_not_found(site_stats, now.year());
        }
    }

    if let Some(expires) = paste_data.expires {
        let now_millis: u64 = now.timestamp_millis() as u64;
        if now_millis as u64 >= expires {
            println!("Deleting paste with ID: {}", id);
            match db.delete_paste(id.to_string()).await {
                Ok(_) => {}
                Err(e) => {
                    eprintln!("Error deleting paste: {:?}", e);
                }
            };
            match db.delete_expired_index(expires) {
                Ok(_) => {}
                Err(e) => {
                    eprintln!("Error deleting expired index: {:?}", e);
                }
            };
            return paste_not_found(site_stats, now.year());
        }
    }

    let site_stats: paste_db::SiteStats = db.get_site_stats();

    let formatted_lang = get_formatted_lang(&paste_data.syntax);

    let template = Template::render(
        "paste",
        context! {
            title: TITLE,
            page: PASTE_PAGE,
            paste: paste_data,
            has_password,
            site_stats,
            year: now.year(),
            formatted_lang,
        },
    );
    (Status::Ok, template)
}

fn paste_not_found(site_stats: paste_db::SiteStats, year: i32) -> (Status, Template) {
    let template = Template::render(
        "paste_not_found",
        context! {title: TITLE, page: NOT_FOUND_PAGE, site_stats, year},
    );
    (Status::NotFound, template)
}

#[get("/faq")]
fn faq(db: &State<Arc<PasteDB>>) -> Template {
    let site_stats: paste_db::SiteStats = db.get_site_stats();
    Template::render(
        "faq",
        context! {title: TITLE, page: FAQ_PAGE, site_stats, year: Utc::now().year()},
    )
}

#[get("/credits")]
fn credits(db: &State<Arc<PasteDB>>) -> Template {
    Template::render(
        "credits",
        context! {title: TITLE, page: CREDITS_PAGE, site_stats: db.get_site_stats(), year: Utc::now().year()},
    )
}

#[get("/tools/password")]
fn password_tools(db: &State<Arc<PasteDB>>) -> Template {
    tool_hub(db, tools::ToolGroup::Password)
}

#[get("/tools/strings")]
fn string_tools(db: &State<Arc<PasteDB>>) -> Template {
    tool_hub(db, tools::ToolGroup::Strings)
}

fn tool_hub(db: &State<Arc<PasteDB>>, group: tools::ToolGroup) -> Template {
    let hub = tools::hub(group);
    let listings = tools::listings();
    Template::render(
        "tool_hub",
        context! {
            title: TITLE,
            page: &hub.page,
            hub,
            listings,
            site_stats: db.get_site_stats(),
            year: Utc::now().year(),
        },
    )
}

#[get("/tools/<slug>")]
fn tool_page(db: &State<Arc<PasteDB>>, slug: &str) -> Option<Template> {
    let tool = tools::find_tool(slug)?;
    Some(Template::render(
        format!("tools/{}", tool.slug),
        context! {
            title: TITLE,
            page: &tool.page,
            tool,
            hub: tools::hub(tool.group),
            listings: tools::listings(),
            site_stats: db.get_site_stats(),
            year: Utc::now().year(),
        },
    ))
}

#[get("/")]
fn index(db: &State<Arc<PasteDB>>) -> Template {
    let site_stats: paste_db::SiteStats = db.get_site_stats();
    let languages: Vec<(&str, &str)> = get_languages();
    Template::render(
        "index",
        context! {title: TITLE, page: INDEX_PAGE, site_stats, languages, year: Utc::now().year()},
    )
}

// Paste URLs are private, so keep crawlers off them (and off the API, where a
// JS-running crawler could use up a paste's views). /share/ and /s/ stay
// crawlable so link previews work; those pages are noindex and hold no paste
// data.
#[get("/robots.txt")]
fn robots(config: &State<AppConfig>) -> (ContentType, String) {
    let body = format!(
        "User-agent: *\nDisallow: /paste/\nDisallow: /api/\n\nSitemap: {}/sitemap.xml\n",
        config.site_url
    );
    (ContentType::Plain, body)
}

#[get("/sitemap.xml")]
fn sitemap(config: &State<AppConfig>) -> (ContentType, String) {
    let site_url = &config.site_url;
    let urls: String = SITEMAP_PATHS
        .into_iter()
        .chain(tools::sitemap_paths())
        .map(|path| format!("  <url><loc>{site_url}{path}</loc></url>\n"))
        .collect();
    let body = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n{urls}</urlset>\n"
    );
    (ContentType::XML, body)
}

fn get_formatted_lang(lang: &str) -> String {
    let languages: Vec<(&str, &str)> = get_languages();
    for (key, value) in languages {
        if key == lang {
            return value.to_string();
        }
    }
    "Plaintext".to_string()
}

fn get_languages() -> Vec<(&'static str, &'static str)> {
    vec![
        ("bash", "Bash"),
        ("c", "C"),
        ("cpp", "C++"),
        ("csharp", "C#"),
        ("css", "CSS"),
        ("diff", "Diff"),
        ("go", "Go"),
        ("graphql", "GraphQL"),
        ("ini", "INI"),
        ("java", "Java"),
        ("javascript", "JavaScript"),
        ("json", "JSON"),
        ("kotlin", "Kotlin"),
        ("less", "Less"),
        ("lua", "Lua"),
        ("makefile", "Makefile"),
        ("markdown", "Markdown"),
        ("objectivec", "Objective-C"),
        ("perl", "Perl"),
        ("php", "PHP"),
        ("php-template", "PHP Template"),
        ("plaintext", "Plaintext"),
        ("python", "Python"),
        ("python-repl", "Python REPL"),
        ("r", "R"),
        ("ruby", "Ruby"),
        ("rust", "Rust"),
        ("scss", "SCSS"),
        ("shell", "Shell"),
        ("sql", "SQL"),
        ("swift", "Swift"),
        ("typescript", "TypeScript"),
        ("vbnet", "VB.NET"),
        ("wasm", "Wasm"),
        ("xml", "XML"),
        ("yaml", "YAML"),
    ]
}

#[launch]
async fn rocket() -> _ {
    let rocket = rocket::build();

    let config = AppConfig::from_figment(rocket.figment()).unwrap_or_else(|e| exit_with(&e));
    for warning in config.warnings() {
        eprintln!("Warning: {warning}");
    }
    for dir in [config.db_dir(), config.file_dir()] {
        config::ensure_dir(&dir).unwrap_or_else(|e| exit_with(&e));
    }
    let db: Arc<PasteDB> = match PasteDB::open(&config.db_dir(), config.file_dir()) {
        Ok(db) => Arc::new(db),
        Err(e) => exit_with(&format!("can't open the database in {:?}: {e}", config.db_dir())),
    };
    db.remove_partial_uploads();
    let db_clone = db.clone();
    let limiter = Arc::new(RateLimiter::new(
        config.pastes_per_minute,
        config.pastes_per_hour,
        config.upload_mib_per_hour * MIB,
    ));
    let limiter_clone = limiter.clone();
    println!(
        "Site URL {}, data in {:?}, static files from {:?}",
        config.site_url, config.data_dir, config.static_dir
    );
    let limit = |n: u64, unit: &str| if n == 0 { "off".to_string() } else { format!("{n} {unit}") };
    println!(
        "Limits per IP: pastes {} / {}, attachments {}. Free disk to keep: {}. \
         Attachment storage cap: {}",
        limit(config.pastes_per_minute, "a minute"),
        limit(config.pastes_per_hour, "an hour"),
        limit(config.upload_mib_per_hour, "MiB an hour"),
        limit(config.min_free_disk_mib, "MiB"),
        limit(config.max_attachment_storage_mib, "MiB"),
    );
    let site_url = config.site_url.clone();
    let static_dir = config.static_dir.clone();

    // Build the Rocket instance
    let rocket = rocket
        .manage(db)
        .manage(config)
        .manage(limiter)
        .mount("/public", FileServer::from(static_dir))
        .mount(
            "/",
            routes![
                index,
                upload,
                retrieve,
                faq,
                credits,
                filter_bots,
                share_short,
                advance_views,
                password_tools,
                string_tools,
                tool_page,
                download_attachment,
                upload_attachment,
                robots,
                sitemap,
                assets::dist_asset,
            ],
        )
        .attach(Template::custom(move |engines| {
            engines
                .minijinja
                .add_global("asset_version", env!("ASSET_VERSION"));
            engines.minijinja.add_global("site_url", site_url.clone());
            // For the Tools menu in nav.html.j2.
            engines.minijinja.add_global(
                "nav_tools",
                rocket_dyn_templates::minijinja::Value::from_serialize(tools::listings()),
            );
        }))
        .attach(CacheControlFairing)
        .attach(WasmFairing);

    // Spawn the background task
    tokio::spawn(async move {
        let db_clone_task = db_clone.clone();
        loop {
            match db_clone_task.remove_expired_paste().await {
                Ok(_) => {}
                Err(e) => {
                    eprintln!("Error removing expired paste: {:?}", e);
                }
            }
            limiter_clone.prune();
            tokio::time::sleep(Duration::from_secs(60 * 15)).await;
        }
    });

    // Launch the Rocket instance
    rocket
}

fn exit_with(message: &str) -> ! {
    eprintln!("Error: {message}");
    std::process::exit(1);
}
