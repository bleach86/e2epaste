//! The site's JSON API (see the server's src/api.rs and src/access.rs).

use std::time::Duration;

use reqwest::{Response, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use url::Url;

use crate::error::Error;

/// The paste format this client makes; the server must take it.
pub const FORMAT_VERSION: u32 = e2epaste_format::FORMAT_VERSION;

const TIMEOUT: Duration = Duration::from_secs(60);
const TRIES: u32 = 4;

pub struct Api {
    http: reqwest::Client,
    site: Url,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct Limits {
    pub format_version: u32,
    pub max_paste_bytes: u64,
    pub max_file_bytes: Option<u64>,
    pub max_paste_label: String,
    pub max_file_label: Option<String>,
}

/// A new paste, as /api/submit_paste takes it.
#[derive(Serialize)]
pub struct NewPaste {
    pub content: String,
    pub iv: Vec<u8>,
    pub expires_in: u64,
    pub max_views: Option<u64>,
    pub delete_after_open: Option<u64>,
    pub key_fragment: String,
    pub has_password: bool,
    pub version: u32,
    pub title: String,
    pub syntax: String,
    pub file_name: Option<String>,
    pub file_size: Option<u64>,
    pub access_hash: String,
}

#[derive(Deserialize)]
pub struct Created {
    pub id: String,
    pub upload_token: Option<String>,
    pub delete_token: Option<String>,
}

/// What /api/info says about a paste: no content, and no view used.
#[derive(Deserialize, Clone, Debug)]
pub struct Info {
    pub id: String,
    pub version: u32,
    pub iv: Vec<u8>,
    pub has_password: bool,
    pub syntax: String,
    /// Seconds since the epoch.
    pub timestamp: i64,
    /// Milliseconds since the epoch.
    pub expires: Option<u64>,
    pub views: u64,
    pub max_views: Option<u64>,
    pub has_attachment: bool,
    /// v1 and v2 only: their titles weren't encrypted.
    pub title: Option<String>,
    pub delete_after_open: Option<u64>,
}

/// An opened paste (one view counted).
#[derive(Deserialize)]
pub struct Opened {
    pub content: String,
    pub title: String,
    pub file_name: Option<String>,
    pub views: u64,
    pub expires: Option<u64>,
    pub last_view: bool,
    pub download_ticket: Option<String>,
}

impl Api {
    pub fn new(site: Url) -> Result<Api, Error> {
        let http = reqwest::Client::builder()
            .user_agent(concat!("e2ep/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(20))
            .build()
            .map_err(|e| Error::Other(format!("can't start the HTTP client: {e}")))?;
        Ok(Api { http, site })
    }

    pub fn site(&self) -> &Url {
        &self.site
    }

    fn url(&self, path: &str) -> Url {
        self.site.join(path).expect("a relative API path")
    }

    /// Sends the request built by `build`. If `repeatable`, tries again after
    /// network errors and server errors (5xx); creating, opening and
    /// deleting aren't, since the first try may have worked (a second paste,
    /// a second view used, or "not found"). Refusals are returned as errors.
    async fn send(
        &self,
        what: Refusing,
        repeatable: bool,
        build: impl Fn() -> reqwest::RequestBuilder,
    ) -> Result<Response, Error> {
        let mut attempt = 1;
        loop {
            let result = build().timeout(TIMEOUT).send().await;
            let retry = repeatable
                && match &result {
                    Err(_) => true,
                    Ok(response) => response.status().is_server_error(),
                };
            if retry && attempt < TRIES {
                tokio::time::sleep(Duration::from_secs(attempt as u64)).await;
                attempt += 1;
                continue;
            }
            let response = result.map_err(|e| {
                Error::Network(format!("can't reach {}: {}", self.site, without_url(&e)))
            })?;
            if response.status().is_success() {
                return Ok(response);
            }
            return Err(refusal(response, what).await);
        }
    }

    pub async fn limits(&self) -> Result<Limits, Error> {
        let response = self
            .send(Refusing::Site, true, || {
                self.http.get(self.url("api/limits"))
            })
            .await
            .map_err(|e| match e {
                Error::NotFound => Error::Unsupported(format!(
                    "{} runs an older e2ePaste without the paste format this client makes",
                    self.site
                )),
                other => other,
            })?;
        let limits: Limits = json(response).await?;
        if limits.format_version < FORMAT_VERSION {
            return Err(Error::Unsupported(format!(
                "{} takes paste format {}, but this client makes format {FORMAT_VERSION}",
                self.site, limits.format_version
            )));
        }
        Ok(limits)
    }

    pub async fn create(&self, paste: &NewPaste) -> Result<Created, Error> {
        let response = self
            .send(Refusing::Paste, false, || {
                self.http.post(self.url("api/submit_paste")).json(paste)
            })
            .await?;
        json(response).await
    }

    pub async fn upload_chunk(
        &self,
        id: &str,
        token: &str,
        index: u64,
        last: bool,
        chunk: Vec<u8>,
    ) -> Result<(), Error> {
        let url = self.url(&format!("api/upload-attachment/{id}/{index}?last={last}"));
        self.send(Refusing::Attachment, true, || {
            self.http
                .post(url.clone())
                .header("Content-Type", "application/octet-stream")
                .header("X-Upload-Token", token)
                .body(chunk.clone())
        })
        .await?;
        Ok(())
    }

    pub async fn info(&self, id: &str) -> Result<Info, Error> {
        let response = self
            .send(Refusing::Paste, true, || {
                self.http.get(self.url(&format!("api/info/{id}")))
            })
            .await?;
        json(response).await
    }

    pub async fn open(&self, id: &str, proof: Option<&str>) -> Result<Opened, Error> {
        let body = serde_json::json!({ "proof": proof });
        let response = self
            .send(Refusing::Open, false, || {
                self.http
                    .post(self.url(&format!("api/open/{id}")))
                    .json(&body)
            })
            .await?;
        json(response).await
    }

    pub async fn download(&self, id: &str, ticket: &str) -> Result<Response, Error> {
        self.send(Refusing::Paste, true, || {
            self.http
                .get(self.url(&format!("api/download-attachment/{id}")))
                .header("X-Download-Ticket", ticket)
        })
        .await
    }

    pub async fn delete(&self, id: &str, token: &str) -> Result<(), Error> {
        self.send(Refusing::Delete, false, || {
            self.http
                .post(self.url(&format!("api/delete/{id}")))
                .header("X-Delete-Token", token)
        })
        .await?;
        Ok(())
    }
}

/// What a request was for, to say what a 403 or 413 means.
#[derive(Clone, Copy)]
enum Refusing {
    Site,
    Paste,
    Attachment,
    Open,
    Delete,
}

async fn json<T: serde::de::DeserializeOwned>(response: Response) -> Result<T, Error> {
    response
        .json()
        .await
        .map_err(|e| Error::Network(format!("the site sent an unexpected answer: {e}")))
}

async fn refusal(response: Response, what: Refusing) -> Error {
    let status = response.status();
    let retry_header = response
        .headers()
        .get("Retry-After")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok());
    let body: Value = response.json().await.unwrap_or_default();
    let reason = body["reason"].as_str().map(str::to_string);
    match status {
        StatusCode::NOT_FOUND => Error::NotFound,
        StatusCode::FORBIDDEN => match what {
            Refusing::Open => Error::WrongKey(
                "the link or the password is wrong (the server checked the access proof)".into(),
            ),
            Refusing::Delete => Error::WrongKey("the delete link isn't valid".into()),
            Refusing::Attachment => {
                Error::Refused("the upload is no longer allowed (it's complete or expired)".into())
            }
            _ => Error::Refused("forbidden".into()),
        },
        StatusCode::TOO_MANY_REQUESTS => Error::RateLimited {
            limit: body["limit"].as_str().map(str::to_string),
            allowed: body["allowed"].as_u64(),
            retry_after: body["retry_after"].as_u64().or(retry_header).unwrap_or(60),
        },
        StatusCode::PAYLOAD_TOO_LARGE => Error::Refused(match what {
            Refusing::Attachment => "the attachment is larger than the site allows".into(),
            _ => "it's larger than the site allows".into(),
        }),
        StatusCode::INSUFFICIENT_STORAGE => Error::Refused(
            if body["reason"] == "attachments" {
                "the site's attachment storage is full (a paste without one may still work)"
            } else {
                "the site is out of storage space"
            }
            .into(),
        ),
        StatusCode::BAD_REQUEST => {
            Error::Refused(reason.unwrap_or_else(|| "the request was invalid".into()))
        }
        status if status.is_server_error() => {
            Error::Network(format!("the site had an error ({status}); try again later"))
        }
        status => Error::Other(format!("unexpected answer from the site: {status}")),
    }
}

/// reqwest's errors include the URL; ours already name the site.
fn without_url(e: &reqwest::Error) -> String {
    let mut message = e.to_string();
    if let Some(url) = e.url() {
        message = message
            .replace(&format!(" ({url})"), "")
            .replace(url.as_str(), "");
    }
    message
}
