//! Errors, each with a stable code (in `--json` output) and exit status, so
//! scripts and agents can tell what happened without reading the message.

use std::fmt;

use serde_json::{json, Value};

#[derive(Debug)]
pub enum Error {
    /// Bad arguments or input. Exit 2.
    Usage(String),
    /// The paste has an attachment and no `--attachment-dir` was given.
    /// Checked before opening, so no view is used. Exit 2.
    AttachmentDirRequired { name_hint: Option<String> },
    /// Doesn't exist, expired, deleted or out of views. Exit 3.
    NotFound,
    /// Wrong or damaged link, wrong password, or wrong delete link. Exit 4.
    WrongKey(String),
    /// The paste needs a password and none was given. Checked before
    /// opening, so no view is used. Exit 5.
    PasswordRequired,
    /// One of the site's limits; try again after `retry_after` seconds. Exit 6.
    RateLimited {
        limit: Option<String>,
        allowed: Option<u64>,
        retry_after: u64,
    },
    /// The site won't take it: too large, storage full, attachments off, or
    /// invalid. Also a paste that decompresses to more than the site allows,
    /// which `get` refuses to inflate. Exit 7.
    Refused(String),
    /// The network, or a server error. Worth retrying later. Exit 8.
    Network(String),
    /// A paste format or server this version can't handle. Exit 9.
    Unsupported(String),
    /// Anything else. Exit 1.
    Other(String),
}

impl Error {
    pub fn code(&self) -> &'static str {
        match self {
            Error::Usage(_) => "usage",
            Error::AttachmentDirRequired { .. } => "attachment_dir_required",
            Error::NotFound => "not_found",
            Error::WrongKey(_) => "wrong_key",
            Error::PasswordRequired => "password_required",
            Error::RateLimited { .. } => "rate_limited",
            Error::Refused(_) => "refused",
            Error::Network(_) => "network",
            Error::Unsupported(_) => "unsupported",
            Error::Other(_) => "error",
        }
    }

    pub fn exit_status(&self) -> u8 {
        match self {
            Error::Usage(_) | Error::AttachmentDirRequired { .. } => 2,
            Error::NotFound => 3,
            Error::WrongKey(_) => 4,
            Error::PasswordRequired => 5,
            Error::RateLimited { .. } => 6,
            Error::Refused(_) => 7,
            Error::Network(_) => 8,
            Error::Unsupported(_) => 9,
            Error::Other(_) => 1,
        }
    }

    pub fn to_json(&self) -> Value {
        let mut value = json!({ "error": self.code(), "message": self.to_string() });
        if let Error::RateLimited {
            limit,
            allowed,
            retry_after,
        } = self
        {
            value["limit"] = json!(limit);
            value["allowed"] = json!(allowed);
            value["retry_after"] = json!(retry_after);
        }
        value
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Usage(message) => write!(f, "{message}"),
            Error::AttachmentDirRequired { name_hint } => write!(
                f,
                "the paste has an attachment{}; pass --attachment-dir DIR to save it, or \
                 --no-attachment to skip it (opening it may use its last view)",
                name_hint
                    .as_deref()
                    .map(|name| format!(" ({name})"))
                    .unwrap_or_default()
            ),
            Error::NotFound => write!(
                f,
                "the paste doesn't exist any more: it expired, was deleted, or has no views left"
            ),
            Error::WrongKey(message) => write!(f, "{message}"),
            Error::PasswordRequired => write!(
                f,
                "the paste needs a password: pass --password-env VAR or --password-file PATH"
            ),
            Error::RateLimited {
                limit,
                allowed,
                retry_after,
            } => {
                let which = match (limit.as_deref(), allowed) {
                    (Some("pastes_per_minute"), Some(n)) => format!("{n} pastes a minute"),
                    (Some("pastes_per_hour"), Some(n)) => format!("{n} pastes an hour"),
                    (Some("upload_mib_per_hour"), Some(n)) => {
                        format!("{n} MiB of attachments an hour")
                    }
                    (Some("failed_attempts_per_hour"), Some(n)) => {
                        format!("{n} failed attempts an hour")
                    }
                    _ => "one of its limits".to_string(),
                };
                write!(
                    f,
                    "the site's limit of {which} was reached; try again in {retry_after} seconds"
                )
            }
            Error::Refused(message) => write!(f, "the site refused it: {message}"),
            Error::Network(message) => write!(f, "{message}"),
            Error::Unsupported(message) => write!(f, "{message}"),
            Error::Other(message) => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for Error {}
