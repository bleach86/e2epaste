#[macro_use]
extern crate rocket;

mod paste_db;
mod paste_id;

use rocket::fs::{relative, FileServer};
use rocket::http::uri::Absolute;
use rocket::serde::json::Json;
use rocket::tokio;
use rocket::State;
use rocket_dyn_templates::{context, Template};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;

use chrono::prelude::*;

use paste_db::{PasteDB, PasteData};
use paste_id::PasteId;

const HOST: Absolute<'static> = uri!("https://e2epaste.xyz");
const TITLE: &str = "e2ePaste";
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
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct IncomingPasteRes {
    pub id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AdvanceViewsRes {
    pub error: Option<String>,
    pub views: Option<u64>,
    pub total_views: Option<u64>,
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
    };

    match db.set_paste(&paste_data) {
        Ok(_) => {
            db.increment_pastes().unwrap();
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
    let mut save_paste = true;

    if let Some(max_views) = paste_data.max_views {
        if paste_data.views >= max_views {
            println!("Deleting paste with ID: {:?}", id);
            db.delete_paste(id.to_string()).unwrap();
            match paste_data.expires {
                Some(expires) => db.delete_expired_index(expires).unwrap(),
                None => {}
            }
            save_paste = false;
        }
    }

    db.increment_views().unwrap();
    if save_paste {
        db.set_paste(&paste_data).unwrap();
    }

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
        context! {title: TITLE, paste_id: id.to_string(), host: HOST, site_stats},
    )
}

#[get("/paste/<id>")]
async fn retrieve(db: &State<Arc<PasteDB>>, id: &str) -> Template {
    let site_stats: paste_db::SiteStats = db.get_site_stats();
    let paste_data: PasteData = match db.get_paste(id.to_string()) {
        Some(paste_data) => paste_data,
        None => return Template::render("paste_not_found", context! {title: TITLE, site_stats}),
    };

    let views: u64 = paste_data.views + 1;

    if let Some(max_views) = paste_data.max_views {
        if views > max_views {
            println!("Deleting paste with ID: {}", id);
            db.delete_paste(id.to_string()).unwrap();
            match paste_data.expires {
                Some(expires) => db.delete_expired_index(expires).unwrap(),
                None => {}
            }
            return Template::render("paste_not_found", context! {title: TITLE, site_stats});
        }
    }

    if let Some(expires) = paste_data.expires {
        let now: u64 = chrono::Utc::now().timestamp_millis() as u64;
        if now >= expires {
            println!("Deleting paste with ID: {}", id);
            db.delete_paste(id.to_string()).unwrap();
            db.delete_expired_index(expires).unwrap();
            return Template::render("paste_not_found", context! {title: TITLE, site_stats});
        }
    }

    let site_stats: paste_db::SiteStats = db.get_site_stats();

    Template::render(
        "paste",
        context! {
            title: TITLE,
            paste: paste_data,
            host: HOST,
            site_stats,
        },
    )
}

#[get("/faq")]
fn faq(db: &State<Arc<PasteDB>>) -> Template {
    let site_stats: paste_db::SiteStats = db.get_site_stats();
    Template::render("faq", context! {title: TITLE, site_stats, host: HOST})
}

#[get("/")]
fn index(db: &State<Arc<PasteDB>>) -> Template {
    let site_stats: paste_db::SiteStats = db.get_site_stats();
    let languages: Vec<(&str, &str)> = vec![
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
    ];
    Template::render(
        "index",
        context! {title: TITLE, site_stats, host: HOST, languages},
    )
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
            routes![index, upload, retrieve, faq, filter_bots, advance_views],
        )
        .attach(Template::fairing());

    // Spawn the background task
    tokio::spawn(async move {
        let db_clone_task = db_clone.clone();
        loop {
            db_clone_task.remove_expired_paste().await.unwrap();
            tokio::time::sleep(Duration::from_secs(60 * 15)).await;
        }
    });

    // Launch the Rocket instance
    rocket
}
