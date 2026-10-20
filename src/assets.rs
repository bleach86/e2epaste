//! Serves /public/js/dist using the precompressed copies webpack writes next
//! to each bundle (`<file>.br`, `<file>.gz`), picking the best one the browser
//! accepts. Rocket has no response compression of its own, and the zxcvbn
//! dictionaries alone are 1.6 MB uncompressed.

use std::convert::Infallible;
use std::path::PathBuf;

use rocket::fs::NamedFile;
use rocket::http::ContentType;
use rocket::request::{self, FromRequest, Request};
use rocket::response::{self, Responder};
use rocket::State;

use crate::config::AppConfig;

/// Which precompressed encodings the client accepts, from Accept-Encoding.
pub struct AcceptEncoding {
    br: bool,
    gzip: bool,
}

#[rocket::async_trait]
impl<'r> FromRequest<'r> for AcceptEncoding {
    type Error = Infallible;

    async fn from_request(req: &'r Request<'_>) -> request::Outcome<Self, Self::Error> {
        let mut accepts = AcceptEncoding { br: false, gzip: false };

        for item in req.headers().get("Accept-Encoding").flat_map(|v| v.split(',')) {
            let mut parts = item.split(';');
            let name = parts.next().unwrap_or("").trim();
            // "q=0" means the client explicitly refuses that encoding.
            let refused = parts.any(|p| {
                p.trim().strip_prefix("q=").and_then(|q| q.parse::<f32>().ok()) == Some(0.0)
            });
            match name {
                "br" => accepts.br = !refused,
                "gzip" => accepts.gzip = !refused,
                _ => {}
            }
        }
        request::Outcome::Success(accepts)
    }
}

pub struct DistAsset {
    file: NamedFile,
    /// Type of the original file; the compressed copy's own extension says
    /// nothing about it.
    content_type: Option<ContentType>,
    encoding: Option<&'static str>,
}

impl<'r> Responder<'r, 'static> for DistAsset {
    fn respond_to(self, req: &'r Request<'_>) -> response::Result<'static> {
        let mut res = self.file.respond_to(req)?;
        if let Some(content_type) = self.content_type {
            res.set_header(content_type);
        }
        if let Some(encoding) = self.encoding {
            res.set_raw_header("Content-Encoding", encoding);
        }
        // Caches must keep compressed and uncompressed responses apart.
        res.set_raw_header("Vary", "Accept-Encoding");
        Ok(res)
    }
}

// Outranks the /public FileServer (rank 10) for this directory.
#[get("/public/js/dist/<path..>")]
pub async fn dist_asset(
    path: PathBuf,
    accepts: AcceptEncoding,
    config: &State<AppConfig>,
) -> Option<DistAsset> {
    let file_path = config.dist_dir().join(&path);
    if !file_path.is_file() {
        return None;
    }
    let content_type = path
        .extension()
        .and_then(|ext| ext.to_str())
        .and_then(ContentType::from_extension);

    for (accepted, encoding, suffix) in [(accepts.br, "br", ".br"), (accepts.gzip, "gzip", ".gz")] {
        if !accepted {
            continue;
        }
        let mut compressed = file_path.clone().into_os_string();
        compressed.push(suffix);
        if let Ok(file) = NamedFile::open(&compressed).await {
            return Some(DistAsset { file, content_type, encoding: Some(encoding) });
        }
    }

    let file = NamedFile::open(&file_path).await.ok()?;
    Some(DistAsset { file, content_type, encoding: None })
}
