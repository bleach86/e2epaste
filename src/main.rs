#[macro_use]
extern crate rocket;

mod paste_db;
mod paste_id;

use crate::rocket::data::ToByteUnit;
use rocket::fairing::Fairing;
use rocket::fs::{relative, FileServer, NamedFile};
use rocket::http::uri::Absolute;
use rocket::http::ContentType;
use rocket::http::Header;
use rocket::request::Request;
use rocket::response::Response;
use rocket::serde::json::Json;
use rocket::tokio;
use rocket::tokio::fs::File;
use rocket::State;
use rocket::{post, Data};
use rocket_dyn_templates::{context, Template};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;

use chrono::prelude::*;

use paste_db::{PasteDB, PasteData};
use paste_id::PasteId;

const HOST: Absolute<'static> = uri!("https://e2epaste.xyz");
const TITLE: &str = "e2ePaste.XYZ";
const ID_LENGTH: usize = 8;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct IncomingPaste {
    pub content: String,
    pub iv: Vec<u8>,
    pub expires: Option<u64>,
    pub max_views: Option<u64>,
    pub key_fragment: String,
    pub password_hash: Option<String>,
    pub title: String,
    pub syntax: String,
    pub file_name: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct IncomingPasteRes {
    pub id: Option<String>,
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
    raw_paste: Json<IncomingPaste>,
) -> Json<IncomingPasteRes> {
    let paste: IncomingPaste = raw_paste.clone().into_inner();
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
        password_hash: paste.password_hash,
        title: paste.title,
        syntax: paste.syntax,
        file_name: paste.file_name,
    };

    match db.set_paste(&paste_data) {
        Ok(_) => {
            match db.increment_pastes() {
                Ok(_) => {}
                Err(e) => {
                    eprintln!("Error incrementing pastes: {:?}", e);
                }
            };
            Json(IncomingPasteRes {
                id: Some(id.to_string()),
            })
        }
        Err(e) => {
            eprintln!("Error saving paste: {:?}", e);
            Json(IncomingPasteRes { id: None })
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

#[get("/share/<id>")]
async fn filter_bots(id: PasteId<'_>, db: &State<Arc<PasteDB>>) -> Template {
    let site_stats: paste_db::SiteStats = db.get_site_stats();
    Template::render(
        "bot_filter",
        context! {title: TITLE, paste_id: id.to_string(), host: HOST, site_stats, year: Utc::now().year()},
    )
}

#[post("/api/upload-attachment/<id>", data = "<data>")]
async fn upload_attachment(data: Data<'_>, id: PasteId<'_>) -> std::io::Result<&'static str> {
    let mut file = File::create(format!("./file_store/{}.bin", id.to_string())).await?;
    data.open(100_u64.megabytes()).stream_to(&mut file).await?;
    Ok("Upload successful")
}
#[get("/api/download-attachment/<id>")]
async fn download_attachment(id: PasteId<'_>) -> Option<NamedFile> {
    let file_path = format!("./file_store/{}.bin", id.to_string());
    NamedFile::open(file_path).await.ok()
}

#[get("/paste/<id>")]
async fn retrieve(db: &State<Arc<PasteDB>>, id: &str) -> Template {
    let site_stats: paste_db::SiteStats = db.get_site_stats();
    let now: DateTime<Utc> = chrono::Utc::now();

    let paste_data: PasteData = match db.get_paste(id.to_string()) {
        Some(paste_data) => paste_data,
        None => {
            return Template::render(
                "paste_not_found",
                context! {title: TITLE, site_stats, year: now.year()},
            )
        }
    };

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
            return Template::render(
                "paste_not_found",
                context! {title: TITLE, site_stats, year: now.year()},
            );
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
            return Template::render(
                "paste_not_found",
                context! {title: TITLE, site_stats, year: now.year()},
            );
        }
    }

    let site_stats: paste_db::SiteStats = db.get_site_stats();

    let formatted_lang = get_formatted_lang(&paste_data.syntax);

    Template::render(
        "paste",
        context! {
            title: TITLE,
            paste: paste_data,
            host: HOST,
            site_stats,
            year: now.year(),
            formatted_lang,
        },
    )
}

#[get("/faq")]
fn faq(db: &State<Arc<PasteDB>>) -> Template {
    let site_stats: paste_db::SiteStats = db.get_site_stats();
    Template::render(
        "faq",
        context! {title: TITLE, site_stats, host: HOST, year: Utc::now().year()},
    )
}

#[get("/tools/password")]
async fn password_gen(db: &State<Arc<PasteDB>>) -> Template {
    let site_stats: paste_db::SiteStats = db.get_site_stats();
    Template::render(
        "password_gen",
        context! {title: TITLE, site_stats, host: HOST, year: Utc::now().year()},
    )
}

#[get("/tools/strings")]
async fn string_tools(db: &State<Arc<PasteDB>>) -> Template {
    let site_stats: paste_db::SiteStats = db.get_site_stats();
    Template::render(
        "string_tools",
        context! {title: TITLE, site_stats, host: HOST, year: Utc::now().year()},
    )
}

#[get("/")]
fn index(db: &State<Arc<PasteDB>>) -> Template {
    let site_stats: paste_db::SiteStats = db.get_site_stats();
    let languages: Vec<(&str, &str)> = get_languages();
    Template::render(
        "index",
        context! {title: TITLE, site_stats, host: HOST, languages, year: Utc::now().year()},
    )
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
    let db: Arc<PasteDB> = Arc::new(PasteDB::new());
    let db_clone = db.clone();

    // Build the Rocket instance
    let rocket = rocket::build()
        .manage(db)
        .mount("/public", FileServer::from(relative!("static")))
        .mount(
            "/",
            routes![
                index,
                upload,
                retrieve,
                faq,
                filter_bots,
                advance_views,
                password_gen,
                string_tools,
                download_attachment,
                upload_attachment
            ],
        )
        .attach(Template::fairing())
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
            tokio::time::sleep(Duration::from_secs(60 * 15)).await;
        }
    });

    // Launch the Rocket instance
    rocket
}
