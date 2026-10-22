//! What e2ep does: create, get, info, delete and limits. Kept apart from the
//! command line so other front ends (an MCP server) can use them too.

use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use futures_util::StreamExt;
use url::Url;

use crate::api::{Api, Info, Limits, NewPaste, FORMAT_VERSION};
use crate::crypto::{self, Details, FileDecryptor, Part, Secrets, MAX_TITLE_CHARS};
use crate::error::Error;
use crate::link::{DeleteLink, PasteLink};

/// Progress messages ("Uploading... 40%"), for showing on stderr.
pub type Progress<'a> = &'a (dyn Fn(&str) + Sync);

/// A password from an environment variable, trimmed as the site's pages
/// trim them.
pub fn password_from_env(var: &str) -> Result<String, Error> {
    let password = std::env::var(var)
        .map_err(|_| Error::Usage(format!("the environment variable {var} isn't set")))?;
    checked_password(password)
}

/// A password read from somewhere, trimmed; an empty one is an error.
pub fn checked_password(password: String) -> Result<String, Error> {
    let password = password.trim().to_string();
    if password.is_empty() {
        return Err(Error::Usage("the password is empty".into()));
    }
    Ok(password)
}

// --- create ----------------------------------------------------------------------

pub struct CreateOptions {
    pub site: Url,
    /// UTF-8 text; can be empty when there's an attachment.
    pub text: String,
    pub title: String,
    /// A highlight.js language, or "auto".
    pub syntax: String,
    /// Seconds.
    pub expires_in: u64,
    pub max_views: Option<u64>,
    /// Seconds after the first view.
    pub delete_after_open: Option<u64>,
    pub password: Option<String>,
    pub attachment: Option<PathBuf>,
}

pub struct CreatedPaste {
    pub id: String,
    pub url: String,
    pub delete_url: String,
    pub expires_in: u64,
    pub max_views: Option<u64>,
    pub delete_after_open: Option<u64>,
    pub password: bool,
    /// Name and size.
    pub attachment: Option<(String, u64)>,
}

pub async fn create(options: CreateOptions, progress: Progress<'_>) -> Result<CreatedPaste, Error> {
    let api = Api::new(options.site.clone())?;
    let limits = api.limits().await?;

    let attachment = match &options.attachment {
        None => None,
        Some(path) => {
            let size = std::fs::metadata(path)
                .map_err(|e| Error::Usage(format!("can't read {}: {e}", path.display())))?
                .len();
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "attachment".into());
            Some((path.clone(), name, size))
        }
    };
    if options.text.is_empty() && attachment.is_none() {
        return Err(Error::Usage(
            "nothing to paste: give text on stdin or a FILE, or --attach a file".into(),
        ));
    }
    let text_bytes = options.text.len() as u64;
    if text_bytes > limits.max_paste_bytes {
        return Err(Error::Refused(format!(
            "the text is {text_bytes} bytes; the site takes up to {}",
            limits.max_paste_label
        )));
    }
    if let Some((_, _, size)) = &attachment {
        match (limits.max_file_bytes, &limits.max_file_label) {
            (None, _) => return Err(Error::Refused("the site doesn't accept attachments".into())),
            (Some(max), label) if *size > max => {
                return Err(Error::Refused(format!(
                    "the attachment is {size} bytes; the site takes up to {}",
                    label.as_deref().unwrap_or("its limit")
                )))
            }
            _ => {}
        }
    }

    // The secret only goes in the link; with a password, the key depends on
    // it too, and the link (not the server) says there is one.
    let iv: [u8; crypto::IV_BYTES] = rand::random();
    let password = options.password.as_deref();
    let link_secret = crypto::new_link_secret(password.is_some());
    let secrets = crypto::derive_secrets(&link_secret, &iv, password)?;

    let title: String = options.title.chars().take(MAX_TITLE_CHARS).collect();
    let details = Details {
        title,
        syntax: options.syntax.clone(),
    };
    let encrypt = |part, data: &[u8]| -> Result<String, Error> {
        Ok(STANDARD.encode(secrets.encrypt_part(part, data)?))
    };
    let paste = NewPaste {
        content: encrypt(Part::Text, options.text.as_bytes())?,
        iv: iv.to_vec(),
        expires_in: options.expires_in,
        max_views: options.max_views,
        delete_after_open: options.delete_after_open,
        key_fragment: String::new(),
        // In the link instead.
        has_password: false,
        version: FORMAT_VERSION,
        title: encrypt(Part::Title, &details.encode())?,
        // Encrypted with the title instead.
        syntax: "auto".into(),
        file_name: attachment
            .as_ref()
            .map(|(_, name, _)| encrypt(Part::FileName, name.as_bytes()))
            .transpose()?,
        file_size: attachment
            .as_ref()
            .map(|(_, _, size)| e2epaste_format::encrypted_file_len(*size)),
        access_hash: crypto::access_hash(&secrets.access_proof),
    };
    let created = api.create(&paste).await?;
    let delete_token = created
        .delete_token
        .ok_or_else(|| Error::Network("the site didn't send a delete token".into()))?;

    if let Some((path, _, size)) = &attachment {
        let token = created
            .upload_token
            .as_deref()
            .ok_or_else(|| Error::Network("the site didn't send an upload token".into()))?;
        upload(&api, &secrets, &created.id, token, path, *size, progress).await?;
    }

    let site = options.site.as_str();
    Ok(CreatedPaste {
        url: format!("{site}s/{}#{link_secret}", created.id),
        delete_url: format!("{site}delete/{}#{delete_token}", created.id),
        id: created.id,
        expires_in: options.expires_in,
        max_views: options.max_views,
        delete_after_open: options.delete_after_open,
        password: password.is_some(),
        attachment: attachment.map(|(_, name, size)| (name, size)),
    })
}

/// Encrypts and uploads the attachment a chunk at a time.
async fn upload(
    api: &Api,
    secrets: &Secrets,
    id: &str,
    token: &str,
    path: &Path,
    size: u64,
    progress: Progress<'_>,
) -> Result<(), Error> {
    let read_error =
        |e: std::io::Error| Error::Usage(format!("can't read {}: {e}", path.display()));
    let mut file = std::fs::File::open(path).map_err(read_error)?;
    let count = Secrets::file_chunk_count(size);
    for index in 0..count {
        let mut read_at = |offset: u64, buffer: &mut [u8]| {
            file.seek(SeekFrom::Start(offset))?;
            file.read_exact(buffer)
        };
        let (chunk, last) = secrets
            .encrypt_file_chunk(size, index, &mut read_at)
            .map_err(read_error)?;
        api.upload_chunk(id, token, index, last, chunk).await?;
        progress(&format!(
            "Uploading the attachment... {}%",
            (index + 1) * 100 / count
        ));
    }
    Ok(())
}

// --- get -------------------------------------------------------------------------

pub struct GetOptions {
    pub link: PasteLink,
    pub password: Option<String>,
    /// Where to save the attachment, if there is one.
    pub attachment_dir: Option<PathBuf>,
    /// Open a paste with an attachment without saving it.
    pub skip_attachment: bool,
}

pub struct GotPaste {
    pub id: String,
    pub title: String,
    /// The chosen language, or "auto".
    pub syntax: String,
    pub text: String,
    pub views: u64,
    pub max_views: Option<u64>,
    /// Milliseconds since the epoch (opening may have started a timer).
    pub expires: Option<u64>,
    /// This was its last view: the paste is gone now.
    pub last_view: bool,
    pub attachment: Option<SavedAttachment>,
}

pub struct SavedAttachment {
    pub name: String,
    pub size: Option<u64>,
    /// Where it was saved; `None` with --no-attachment, or when it failed.
    pub path: Option<PathBuf>,
    /// Why it wasn't saved, when it should have been. The paste's text is
    /// still reported: the view is used by then, and may have been the
    /// last.
    pub error: Option<Error>,
}

pub async fn get(options: GetOptions, progress: Progress<'_>) -> Result<GotPaste, Error> {
    let link = &options.link;
    let api = Api::new(link.site.clone())?;
    let info = api.info(&link.id).await?;
    if info.version < 3 {
        return Err(Error::Unsupported(
            "this paste was made by an older version of e2ePaste; open it in a browser".into(),
        ));
    }

    // Everything that could stop it is checked before opening it, since
    // opening uses a view, perhaps the last.
    let needs_password = needs_password(&info, &link.secret);
    if needs_password && options.password.is_none() {
        return Err(Error::PasswordRequired);
    }
    if info.has_attachment && !options.skip_attachment {
        match &options.attachment_dir {
            None => return Err(Error::AttachmentDirRequired { name_hint: None }),
            Some(dir) if !dir.is_dir() => {
                return Err(Error::Usage(format!("{} isn't a directory", dir.display())))
            }
            Some(_) => {}
        }
    }
    let password = options.password.as_deref().filter(|_| needs_password);
    let secrets = crypto::derive_secrets(&link.secret, &info.iv, password)?;

    let opened = api.open(&link.id, Some(&secrets.access_proof)).await?;
    let version = info.version;
    let decrypt = |part, base64: &str| -> Result<Vec<u8>, Error> {
        let bytes = STANDARD
            .decode(base64)
            .map_err(|_| Error::Network("the site sent a damaged paste".into()))?;
        secrets.decrypt_part(version, part, &bytes)
    };
    // The view is used now, perhaps the last one, so from here on only the
    // text itself can stop the paste from being reported: a title or
    // attachment name that won't decrypt falls back to nothing (as the
    // site's page does), and an attachment that can't be saved is reported
    // with the text rather than instead of it.
    let text = String::from_utf8_lossy(&decrypt(Part::Text, &opened.content)?).into_owned();
    let (title, syntax) = if version >= 4 {
        let details = decrypt(Part::Title, &opened.title)
            .map(|bytes| Details::decode(&bytes))
            .unwrap_or_else(|_| Details {
                title: String::new(),
                syntax: "auto".into(),
            });
        (details.title, details.syntax)
    } else {
        let title = decrypt(Part::Title, &opened.title).unwrap_or_default();
        (
            String::from_utf8_lossy(&title).into_owned(),
            info.syntax.clone(),
        )
    };

    let attachment = match &opened.file_name {
        None => None,
        Some(encrypted_name) => {
            let name = decrypt(Part::FileName, encrypted_name)
                .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
                .unwrap_or_else(|_| "attachment".into());
            match (&options.attachment_dir, &opened.download_ticket) {
                (Some(dir), Some(ticket)) if !options.skip_attachment => {
                    let saved = download(
                        &api, &secrets, version, &link.id, ticket, dir, &name, progress,
                    )
                    .await;
                    Some(match saved {
                        Ok((path, size)) => SavedAttachment {
                            name,
                            size: Some(size),
                            path: Some(path),
                            error: None,
                        },
                        Err(error) => SavedAttachment {
                            name,
                            size: None,
                            path: None,
                            error: Some(error),
                        },
                    })
                }
                (Some(_), None) if !options.skip_attachment => Some(SavedAttachment {
                    name,
                    size: None,
                    path: None,
                    error: Some(Error::Network(
                        "the site didn't send a download ticket for the attachment".into(),
                    )),
                }),
                _ => Some(SavedAttachment {
                    name,
                    size: None,
                    path: None,
                    error: None,
                }),
            }
        }
    };

    Ok(GotPaste {
        id: link.id.clone(),
        title,
        syntax,
        text,
        views: opened.views,
        max_views: info.max_views,
        expires: opened.expires,
        last_view: opened.last_view,
        attachment,
    })
}

/// v4 links say whether there's a password (the server isn't told); older
/// pastes told the server.
fn needs_password(info: &Info, secret: &str) -> bool {
    if info.version >= 4 {
        crypto::link_has_password(secret)
    } else {
        info.has_password
    }
}

/// Downloads and decrypts the attachment into `dir`, under its own name
/// made safe (no paths), without overwriting anything. Returns where it went
/// and its size.
#[allow(clippy::too_many_arguments)]
async fn download(
    api: &Api,
    secrets: &Secrets,
    version: u32,
    id: &str,
    ticket: &str,
    dir: &Path,
    name: &str,
    progress: Progress<'_>,
) -> Result<(PathBuf, u64), Error> {
    let response = api.download(id, ticket).await?;
    let total = response.content_length();
    let partial = dir.join(format!(
        ".e2ep-{}.part",
        hex::encode(rand::random::<[u8; 8]>())
    ));
    let write_error = |e: std::io::Error| Error::Other(format!("can't save the attachment: {e}"));
    let file = std::fs::File::create(&partial).map_err(write_error)?;

    let result: Result<u64, Error> = async {
        if version >= 4 {
            // Decrypted chunk by chunk as it arrives, straight to the file.
            let mut decryptor = FileDecryptor::new(secrets, std::io::BufWriter::new(file));
            let mut received = 0u64;
            let mut stream = response.bytes_stream();
            while let Some(bytes) = stream.next().await {
                let bytes =
                    bytes.map_err(|e| Error::Network(format!("the download failed: {e}")))?;
                received += bytes.len() as u64;
                decryptor.push(&bytes)?;
                if let Some(total) = total.filter(|t| *t > 0) {
                    progress(&format!(
                        "Downloading the attachment... {}%",
                        received * 100 / total
                    ));
                }
            }
            decryptor.finish()
        } else {
            let bytes = response
                .bytes()
                .await
                .map_err(|e| Error::Network(format!("the download failed: {e}")))?;
            let plain = secrets.decrypt_part(version, Part::File, &bytes)?;
            let mut file = file;
            file.write_all(&plain).map_err(write_error)?;
            Ok(plain.len() as u64)
        }
    }
    .await;

    let size = match result {
        Ok(size) => size,
        Err(e) => {
            let _ = std::fs::remove_file(&partial);
            return Err(e);
        }
    };
    let path = unused_path(dir, &safe_file_name(name));
    std::fs::rename(&partial, &path).map_err(|e| {
        let _ = std::fs::remove_file(&partial);
        write_error(e)
    })?;
    Ok((path, size))
}

/// The name without any directories or control characters, so a paste
/// can't write outside the chosen directory.
fn safe_file_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let clean: String = base.chars().filter(|c| !c.is_control()).take(200).collect();
    let clean = clean.trim().trim_start_matches('.').to_string();
    if clean.is_empty() {
        "attachment".into()
    } else {
        clean
    }
}

/// `dir/name`, or `dir/name (2).ext` and so on if that's taken.
fn unused_path(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (stem, format!(".{ext}")),
        _ => (name, String::new()),
    };
    (2..)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|path| !path.exists())
        .expect("some number is free")
}

// --- info, delete, limits --------------------------------------------------------

pub struct PasteInfo {
    pub info: Info,
    pub needs_password: bool,
}

/// What can be known about a paste without opening it (no view is used).
pub async fn info(link: &PasteLink) -> Result<PasteInfo, Error> {
    let info = Api::new(link.site.clone())?.info(&link.id).await?;
    Ok(PasteInfo {
        needs_password: needs_password(&info, &link.secret),
        info,
    })
}

pub async fn delete(link: &DeleteLink) -> Result<(), Error> {
    Api::new(link.site.clone())?
        .delete(&link.id, &link.token)
        .await
}

pub async fn limits(site: Url) -> Result<Limits, Error> {
    Api::new(site)?.limits().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_names_stay_in_the_directory() {
        assert_eq!(safe_file_name("report.pdf"), "report.pdf");
        assert_eq!(
            safe_file_name("../../.ssh/authorized_keys"),
            "authorized_keys"
        );
        assert_eq!(safe_file_name("C:\\\\Windows\\\\x.dll"), "x.dll");
        assert_eq!(safe_file_name(".bashrc"), "bashrc");
        assert_eq!(safe_file_name("a\nb\u{7}.txt"), "ab.txt");
        assert_eq!(safe_file_name(".."), "attachment");
        assert_eq!(safe_file_name(""), "attachment");
    }

    #[test]
    fn never_overwrites() {
        let dir = std::env::temp_dir().join(format!(
            "e2ep-test-{}",
            hex::encode(rand::random::<[u8; 6]>())
        ));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(unused_path(&dir, "a.txt"), dir.join("a.txt"));
        std::fs::write(dir.join("a.txt"), "x").unwrap();
        assert_eq!(unused_path(&dir, "a.txt"), dir.join("a (2).txt"));
        std::fs::write(dir.join("a (2).txt"), "x").unwrap();
        assert_eq!(unused_path(&dir, "a.txt"), dir.join("a (3).txt"));
        assert_eq!(unused_path(&dir, "noext"), dir.join("noext"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
