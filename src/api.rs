//! Shared pieces of the JSON API: error responses, the client IP guard and
//! the storage checks.

use std::convert::Infallible;
use std::net::IpAddr;

use rocket::http::Status;
use rocket::request::{self, FromRequest, Request};
use rocket::response::{self, Responder, Response};
use rocket::serde::json::Json;

use crate::config::{AppConfig, MIB};
use crate::paste_db::PasteDB;
use crate::rate_limit::{Limit, Limited};

/// Errors the pages tell the user about. Bodies are JSON:
/// - `{"error": "rate_limited", "limit": "pastes_per_minute" |
///   "pastes_per_hour" | "upload_mib_per_hour" | "failed_attempts_per_hour",
///   "allowed": <the setting>, "retry_after": <seconds>}`
/// - `{"error": "storage_full", "reason": "disk" | "attachments"}`
/// - `{"error": "invalid", "reason": "..."}`
///
/// Other failures are a bare status.
#[derive(Debug)]
pub enum ApiError {
    /// 429, with a Retry-After header.
    RateLimited(Limited),
    /// 507: the disk is nearly full, or the attachment storage cap is reached.
    StorageFull(Storage),
    /// 400: the request isn't valid, and why.
    Invalid(&'static str),
    Status(Status),
}

/// Which storage limit was reached.
#[derive(Debug, Clone, Copy)]
pub enum Storage {
    /// min_free_disk_mib: nothing new can be stored.
    Disk,
    /// max_attachment_storage_mib: pastes without an attachment still can.
    Attachments,
}

impl From<Status> for ApiError {
    fn from(status: Status) -> Self {
        ApiError::Status(status)
    }
}

impl<'r> Responder<'r, 'static> for ApiError {
    fn respond_to(self, req: &'r Request<'_>) -> response::Result<'static> {
        match self {
            ApiError::RateLimited(Limited { limit, wait }) => {
                let seconds = (wait.as_secs_f64().ceil() as u64).max(1);
                let (name, allowed) = match limit {
                    Limit::PastesPerMinute(n) => ("pastes_per_minute", n),
                    Limit::PastesPerHour(n) => ("pastes_per_hour", n),
                    Limit::UploadBytesPerHour(bytes) => ("upload_mib_per_hour", bytes / MIB),
                    Limit::FailedAttemptsPerHour(n) => ("failed_attempts_per_hour", n),
                };
                let body = Json(serde_json::json!({
                    "error": "rate_limited",
                    "limit": name,
                    "allowed": allowed,
                    "retry_after": seconds,
                }));
                Response::build_from(body.respond_to(req)?)
                    .status(Status::TooManyRequests)
                    .raw_header("Retry-After", seconds.to_string())
                    .ok()
            }
            ApiError::StorageFull(storage) => {
                let reason = match storage {
                    Storage::Disk => "disk",
                    Storage::Attachments => "attachments",
                };
                let body = Json(serde_json::json!({"error": "storage_full", "reason": reason}));
                Response::build_from(body.respond_to(req)?)
                    .status(Status::InsufficientStorage)
                    .ok()
            }
            ApiError::Invalid(reason) => {
                let body = Json(serde_json::json!({"error": "invalid", "reason": reason}));
                Response::build_from(body.respond_to(req)?)
                    .status(Status::BadRequest)
                    .ok()
            }
            ApiError::Status(status) => Err(status),
        }
    }
}

/// The client's IP: from the X-Real-IP header the reverse proxy sets, or the
/// connection's address when there is none (see Rocket's `ip_header`).
pub struct ClientIp(pub Option<IpAddr>);

#[rocket::async_trait]
impl<'r> FromRequest<'r> for ClientIp {
    type Error = Infallible;

    async fn from_request(req: &'r Request<'_>) -> request::Outcome<Self, Infallible> {
        request::Outcome::Success(ClientIp(req.client_ip()))
    }
}

/// Refuses new data when the disk is nearly full, or when `attachment_bytes`
/// more would go over the attachment storage cap.
pub fn check_storage(
    db: &PasteDB,
    config: &AppConfig,
    attachment_bytes: u64,
) -> Result<(), ApiError> {
    if config.min_free_disk_mib > 0 {
        match db.available_disk_space() {
            Ok(free) if free < config.min_free_disk_mib * MIB + attachment_bytes => {
                eprintln!("Refusing new data: only {} MiB free on disk", free / MIB);
                return Err(ApiError::StorageFull(Storage::Disk));
            }
            Ok(_) => {}
            // Better to keep working than to refuse everything.
            Err(e) => eprintln!("Error checking free disk space: {e:?}"),
        }
    }
    if config.max_attachment_storage_mib > 0
        && attachment_bytes > 0
        && db.attachment_storage_used() + attachment_bytes > config.max_attachment_storage_mib * MIB
    {
        eprintln!("Refusing attachment: max_attachment_storage_mib reached");
        return Err(ApiError::StorageFull(Storage::Attachments));
    }
    Ok(())
}
