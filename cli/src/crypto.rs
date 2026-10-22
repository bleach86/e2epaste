//! The e2ePaste paste format, as js/crypto.mjs makes and reads it: the link
//! secret, key and access-proof derivation, padded parts (v4) and chunked
//! attachments (v4). v3 pastes can be read too; v1 and v2 can't (open those
//! in a browser).

use std::io::{Read, Write};

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use e2epaste_format as format;
use flate2::read::ZlibDecoder;
use flate2::write::ZlibEncoder;
use flate2::Compression;
use hkdf::Hkdf;
use sha2::{Digest, Sha256};

use crate::error::Error;

const PBKDF2_ROUNDS: u32 = 600_000;
const INFO_KEY: &[u8] = b"e2epaste-v3";
const INFO_PASSWORD_KEY: &[u8] = b"e2epaste-v3-password";
const INFO_PROOF: &[u8] = b"e2epaste-v3-access";
const INFO_PASSWORD_PROOF: &[u8] = b"e2epaste-v3-password-access";

const SECRET_BYTES: usize = 16;
const SECRET_CHARS: usize = 22;
const BASE64URL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
/// 16 bytes take 22 base64 characters, which hold 132 bits: the last
/// character's low 4 bits are spare. v4 links use one for "has a password".
const SPARE_BITS: u8 = 0b1111;
const FLAG_PASSWORD: u8 = 0b0001;

pub const IV_BYTES: usize = 12;

/// A part of a paste, each encrypted with its own IV.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Part {
    Text,
    /// v4: the title and the language (see `Details`).
    Title,
    FileName,
    File,
}

impl Part {
    fn label(self) -> &'static str {
        match self {
            Part::Text => "text",
            Part::Title => "title",
            Part::FileName => "file-name",
            Part::File => "file",
        }
    }

    /// `None` for the file, which is padded and encrypted in chunks
    /// (`encrypt_file_chunk`) rather than as one part.
    fn padding(self) -> Option<format::Padding> {
        match self {
            Part::Text => Some(format::TEXT),
            Part::Title => Some(format::TITLE),
            Part::FileName => Some(format::FILE_NAME),
            Part::File => None,
        }
    }
}

// --- The link secret ---------------------------------------------------------

/// A new paste's link secret: 128 random bits as 22 base64url characters,
/// with the password flag in the last character's spare bits.
pub fn new_link_secret(password: bool) -> String {
    let bytes: [u8; SECRET_BYTES] = rand::random();
    let secret = URL_SAFE_NO_PAD.encode(bytes);
    if password {
        with_last_char(&secret, |value| value | FLAG_PASSWORD)
    } else {
        secret
    }
}

/// v4: whether the link says the paste has a password. Only a complete
/// secret is read.
pub fn link_has_password(secret: &str) -> bool {
    secret.len() == SECRET_CHARS
        && secret
            .bytes()
            .last()
            .and_then(char_value)
            .is_some_and(|value| value & FLAG_PASSWORD != 0)
}

fn char_value(c: u8) -> Option<u8> {
    BASE64URL.iter().position(|&b| b == c).map(|i| i as u8)
}

fn with_last_char(secret: &str, change: impl Fn(u8) -> u8) -> String {
    let Some(value) = secret.bytes().last().and_then(char_value) else {
        return secret.to_string();
    };
    let mut out = secret[..secret.len() - 1].to_string();
    out.push(BASE64URL[change(value) as usize] as char);
    out
}

fn decode_secret(secret: &str) -> Result<[u8; SECRET_BYTES], Error> {
    let bad = || Error::WrongKey("the link is incomplete or damaged".into());
    if secret.len() != SECRET_CHARS {
        return Err(bad());
    }
    // The flags aren't part of the secret.
    let clean = with_last_char(secret, |value| value & !SPARE_BITS);
    URL_SAFE_NO_PAD
        .decode(clean)
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or_else(bad)
}

// --- Keys ----------------------------------------------------------------------

/// A paste's key and base IV, and the access proof the server asks for.
pub struct Secrets {
    cipher: Aes256Gcm,
    base_iv: [u8; IV_BYTES],
    /// Hex, sent to /api/open.
    pub access_proof: String,
}

/// The key and access proof for a paste, from its link secret, its IV (the
/// salt) and the password, if any. Matches js/crypto.mjs deriveV3Secrets.
pub fn derive_secrets(
    link_secret: &str,
    iv: &[u8],
    password: Option<&str>,
) -> Result<Secrets, Error> {
    let secret = decode_secret(link_secret)?;
    let base_iv: [u8; IV_BYTES] = iv
        .try_into()
        .map_err(|_| Error::Unsupported("the paste's IV isn't 12 bytes".into()))?;
    let mut ikm = secret.to_vec();
    if let Some(password) = password {
        let mut stretched = [0u8; 32];
        pbkdf2::pbkdf2_hmac::<Sha256>(password.as_bytes(), iv, PBKDF2_ROUNDS, &mut stretched);
        ikm.extend_from_slice(&stretched);
    }
    let (key_info, proof_info) = if password.is_some() {
        (INFO_PASSWORD_KEY, INFO_PASSWORD_PROOF)
    } else {
        (INFO_KEY, INFO_PROOF)
    };
    let hkdf = Hkdf::<Sha256>::new(Some(iv), &ikm);
    let mut key = [0u8; 32];
    let mut proof = [0u8; 32];
    hkdf.expand(key_info, &mut key)
        .and_then(|_| hkdf.expand(proof_info, &mut proof))
        .map_err(|_| Error::Other("key derivation failed".into()))?;
    Ok(Secrets {
        cipher: Aes256Gcm::new_from_slice(&key).expect("a 32-byte key"),
        base_iv,
        access_proof: hex::encode(proof),
    })
}

/// What the server stores in place of the access proof.
pub fn access_hash(access_proof_hex: &str) -> String {
    let bytes = hex::decode(access_proof_hex).unwrap_or_default();
    hex::encode(Sha256::digest(bytes))
}

/// A separate IV for each part: SHA-256(base IV || label), first 12 bytes.
fn derive_iv(base_iv: &[u8; IV_BYTES], label: &str) -> [u8; IV_BYTES] {
    let mut hasher = Sha256::new();
    hasher.update(base_iv);
    hasher.update(label.as_bytes());
    hasher.finalize()[..IV_BYTES]
        .try_into()
        .expect("12 of 32 bytes")
}

impl Secrets {
    fn part_iv(&self, part: Part) -> [u8; IV_BYTES] {
        match part {
            Part::Text => self.base_iv,
            other => derive_iv(&self.base_iv, other.label()),
        }
    }

    fn encrypt_raw(&self, iv: &[u8; IV_BYTES], plain: &[u8]) -> Vec<u8> {
        self.cipher
            .encrypt(&Nonce::from(*iv), plain)
            .expect("AES-GCM encryption doesn't fail")
    }

    fn decrypt_raw(&self, iv: &[u8; IV_BYTES], encrypted: &[u8]) -> Result<Vec<u8>, Error> {
        self.cipher
            .decrypt(&Nonce::from(*iv), encrypted)
            .map_err(|_| Error::WrongKey("the paste doesn't decrypt with this link".into()))
    }

    /// v4: a part deflated, length-prefixed, padded and encrypted.
    pub fn encrypt_part(&self, part: Part, data: &[u8]) -> Result<Vec<u8>, Error> {
        let padding = part.padding().expect("attachments are encrypted in chunks");
        let compressed = deflate(data);
        let padded_len = format::padded_len(compressed.len() as u64, padding)
            .ok_or_else(|| Error::Refused(format!("the {} is too long", part.label())))?;
        let mut plain = Vec::with_capacity(padded_len as usize);
        plain.extend_from_slice(&(compressed.len() as u32).to_be_bytes());
        plain.extend_from_slice(&compressed);
        plain.resize(padded_len as usize, 0);
        Ok(self.encrypt_raw(&self.part_iv(part), &plain))
    }

    /// Decrypts a part of a paste in `version`'s format. `max_bytes` is
    /// the most it may inflate to (see `inflate`): the site's text or file
    /// limit for those, `SMALL_PART_BYTES` for the title and file name.
    pub fn decrypt_part(
        &self,
        version: u32,
        part: Part,
        encrypted: &[u8],
        max_bytes: u64,
    ) -> Result<Vec<u8>, Error> {
        let plain = self.decrypt_raw(&self.part_iv(part), encrypted)?;
        if version >= 4 {
            let damaged = || Error::Other("the decrypted paste is damaged".into());
            let len_bytes: [u8; 4] = plain
                .get(..4)
                .and_then(|b| b.try_into().ok())
                .ok_or_else(damaged)?;
            let len = u32::from_be_bytes(len_bytes) as usize;
            let data = plain.get(4..4 + len).ok_or_else(damaged)?;
            return match inflate(data, max_bytes) {
                Ok(out) => Ok(out),
                Err(Inflated::TooLarge) => Err(too_large(part, max_bytes)),
                Err(Inflated::Damaged) => Err(damaged()),
            };
        }
        // v3: deflated, except pastes from before compression existed, whose
        // bytes aren't a zlib stream and are taken as they are. Only a
        // damaged stream falls back: one that's too large stays refused.
        match inflate(&plain, max_bytes) {
            Ok(out) => Ok(out),
            Err(Inflated::TooLarge) => Err(too_large(part, max_bytes)),
            Err(Inflated::Damaged) => Ok(plain),
        }
    }
}

/// The most a title or file name may inflate to: far above what the create
/// page sends (64 characters, 255 bytes), and all a bomb in one is allowed.
pub const SMALL_PART_BYTES: u64 = 64 * 1024;

/// Room above the site's text limit for a paste made before the limit was
/// lowered, or whose creator counted characters rather than bytes.
pub const TEXT_SLACK_BYTES: u64 = 64 * 1024;

/// The most a site can set max_file_mib to (the server's src/config.rs),
/// for pre-v4 attachments on a site that has since turned attachments off.
pub const FILE_BYTES_CEILING: u64 = 4096 * 1024 * 1024;

/// The site never meant to hold anything this large, so it's refused the
/// way the site refuses a paste that's too big to send (exit 7, `refused`).
fn too_large(part: Part, max_bytes: u64) -> Error {
    Error::Refused(format!(
        "the paste's {} decompresses to more than {max_bytes} bytes, over the site's limit",
        part.label()
    ))
}

fn deflate(data: &[u8]) -> Vec<u8> {
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(data).expect("writing to a Vec");
    encoder.finish().expect("writing to a Vec")
}

/// Why `inflate` stopped: the output passed the limit, or the stream isn't
/// valid zlib.
#[derive(Debug, PartialEq, Eq)]
enum Inflated {
    TooLarge,
    Damaged,
}

/// Inflates `data` (zlib), reading no more than `max_bytes` of output. The
/// server only checks a paste's encrypted size, so a megabyte of deflated
/// zeros would otherwise come out as a gigabyte, in memory, on every `get`.
fn inflate(data: &[u8], max_bytes: u64) -> Result<Vec<u8>, Inflated> {
    // One byte past the limit says whether the stream had more to give.
    let mut out = Vec::new();
    ZlibDecoder::new(data)
        .take(max_bytes.saturating_add(1))
        .read_to_end(&mut out)
        .map_err(|_| Inflated::Damaged)?;
    if out.len() as u64 > max_bytes {
        return Err(Inflated::TooLarge);
    }
    Ok(out)
}

// --- v4 details: the title and the language --------------------------------

pub struct Details {
    pub title: String,
    /// A highlight.js language, or "auto" to guess it when viewing.
    pub syntax: String,
}

/// Longest title, in characters, as the create page cuts it.
pub const MAX_TITLE_CHARS: usize = 64;

impl Details {
    pub fn encode(&self) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({ "title": self.title, "syntax": self.syntax }))
            .expect("serializing strings")
    }

    pub fn decode(bytes: &[u8]) -> Details {
        let value: serde_json::Value = serde_json::from_slice(bytes).unwrap_or_default();
        let field = |name: &str, default: &str| value[name].as_str().unwrap_or(default).to_string();
        Details {
            title: field("title", ""),
            syntax: field("syntax", "auto"),
        }
    }
}

// --- v4 attachments ------------------------------------------------------------
//
// The stream [8-byte size][file][zeros], padded to a Padmé size and cut into
// 1 MiB chunks, each encrypted on its own. A chunk's nonce is a per-file
// prefix, the chunk's number and whether it's the last one, so chunks can't
// be reordered, dropped or swapped in from another file. See js/crypto.mjs.

const CHUNK: u64 = format::FILE_CHUNK_BYTES;
const ENCRYPTED_CHUNK: usize = format::ENCRYPTED_CHUNK_BYTES as usize;

impl Secrets {
    fn chunk_nonce(&self, index: u32, last: bool) -> [u8; IV_BYTES] {
        let mut nonce = [0u8; IV_BYTES];
        nonce[..7].copy_from_slice(&derive_iv(&self.base_iv, Part::File.label())[..7]);
        nonce[7..11].copy_from_slice(&index.to_be_bytes());
        nonce[11] = last as u8;
        nonce
    }

    /// Encrypts chunk `index` of a `size`-byte file, reading its part of the
    /// file with `read_at(offset, buffer)`.
    pub fn encrypt_file_chunk(
        &self,
        size: u64,
        index: u64,
        read_at: &mut dyn FnMut(u64, &mut [u8]) -> std::io::Result<()>,
    ) -> std::io::Result<(Vec<u8>, bool)> {
        let padded = format::padded_file_len(size);
        let count = padded.div_ceil(CHUNK);
        let start = index * CHUNK;
        let end = padded.min(start + CHUNK);
        let mut plain = vec![0u8; (end - start) as usize];
        if index == 0 {
            plain[..8].copy_from_slice(&size.to_be_bytes());
        }
        let header = format::FILE_SIZE_BYTES;
        let file_start = start.saturating_sub(header);
        let file_end = size.min(end.saturating_sub(header));
        if file_end > file_start {
            let at = (file_start + header - start) as usize;
            read_at(
                file_start,
                &mut plain[at..at + (file_end - file_start) as usize],
            )?;
        }
        let last = index == count - 1;
        let nonce = self.chunk_nonce(index as u32, last);
        Ok((self.encrypt_raw(&nonce, &plain), last))
    }

    pub fn file_chunk_count(size: u64) -> u64 {
        format::padded_file_len(size).div_ceil(CHUNK)
    }
}

/// Decrypts a v4 attachment as it downloads: feed it the bytes as they
/// arrive, then call `finish`. The file is written to `out` as it's
/// decrypted.
pub struct FileDecryptor<'a, W: Write> {
    secrets: &'a Secrets,
    out: W,
    pending: Vec<u8>,
    index: u32,
    /// The file's size, from the first chunk.
    size: Option<u64>,
    remaining: u64,
}

impl<'a, W: Write> FileDecryptor<'a, W> {
    pub fn new(secrets: &'a Secrets, out: W) -> Self {
        FileDecryptor {
            secrets,
            out,
            pending: Vec::new(),
            index: 0,
            size: None,
            remaining: 0,
        }
    }

    pub fn push(&mut self, bytes: &[u8]) -> Result<(), Error> {
        self.pending.extend_from_slice(bytes);
        // Keep at least one chunk back: only the end of the download says
        // which one is the last.
        while self.pending.len() > ENCRYPTED_CHUNK {
            let chunk: Vec<u8> = self.pending.drain(..ENCRYPTED_CHUNK).collect();
            self.open(&chunk, false)?;
        }
        Ok(())
    }

    /// The file's size.
    pub fn finish(mut self) -> Result<u64, Error> {
        let rest = std::mem::take(&mut self.pending);
        if rest.len() <= format::TAG_BYTES as usize {
            return Err(Error::Other("the attachment is cut off".into()));
        }
        self.open(&rest, true)?;
        if self.remaining != 0 {
            return Err(Error::Other(
                "the attachment is shorter than it says".into(),
            ));
        }
        self.out.flush().map_err(io_error)?;
        Ok(self.size.unwrap_or(0))
    }

    fn open(&mut self, chunk: &[u8], last: bool) -> Result<(), Error> {
        let nonce = self.secrets.chunk_nonce(self.index, last);
        let plain = self
            .secrets
            .decrypt_raw(&nonce, chunk)
            .map_err(|_| Error::Other("the attachment was changed or is damaged".into()))?;
        self.index += 1;
        let mut data = plain.as_slice();
        if self.size.is_none() {
            let size_bytes: [u8; 8] = data
                .get(..8)
                .and_then(|b| b.try_into().ok())
                .ok_or_else(|| Error::Other("the attachment is damaged".into()))?;
            let size = u64::from_be_bytes(size_bytes);
            self.size = Some(size);
            self.remaining = size;
            data = &data[8..];
        }
        // What's left after the file is padding.
        let used = (self.remaining as usize).min(data.len());
        self.out.write_all(&data[..used]).map_err(io_error)?;
        self.remaining -= used as u64;
        Ok(())
    }
}

fn io_error(e: std::io::Error) -> Error {
    Error::Other(format!("can't write the attachment: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn link_secret_and_flag() {
        for _ in 0..200 {
            let plain = new_link_secret(false);
            let flagged = new_link_secret(true);
            assert_eq!(plain.len(), 22);
            assert!(!link_has_password(&plain) && link_has_password(&flagged));
            assert!(decode_secret(&flagged).is_ok());
        }
        let secret = new_link_secret(false);
        let flagged = with_last_char(&secret, |v| v | FLAG_PASSWORD);
        assert_eq!(
            decode_secret(&secret).unwrap(),
            decode_secret(&flagged).unwrap()
        );
        assert!(
            !link_has_password(&flagged[..18]),
            "a cut-off link has no flag"
        );
        assert!(decode_secret(&secret[..20]).is_err());
    }

    #[test]
    fn parts_round_trip_and_are_padded() {
        let secrets = derive_secrets(&new_link_secret(false), &[7; 12], None).unwrap();
        let text = secrets.encrypt_part(Part::Text, b"hello").unwrap();
        assert_eq!(text.len(), 4096 + 16);
        assert_eq!(
            secrets
                .decrypt_part(4, Part::Text, &text, TEXT_SLACK_BYTES)
                .unwrap(),
            b"hello"
        );
        let details = Details {
            title: "T".into(),
            syntax: "rust".into(),
        };
        let title = secrets
            .encrypt_part(Part::Title, &details.encode())
            .unwrap();
        assert_eq!(title.len(), 512 + 16);
        let back = Details::decode(
            &secrets
                .decrypt_part(4, Part::Title, &title, SMALL_PART_BYTES)
                .unwrap(),
        );
        assert_eq!((back.title.as_str(), back.syntax.as_str()), ("T", "rust"));
    }

    #[test]
    fn passwords_change_the_key_and_proof() {
        let link = new_link_secret(true);
        let a = derive_secrets(&link, &[1; 12], Some("pw")).unwrap();
        let b = derive_secrets(&link, &[1; 12], Some("other")).unwrap();
        assert_ne!(a.access_proof, b.access_proof);
        let encrypted = a.encrypt_part(Part::Text, b"x").unwrap();
        assert!(b
            .decrypt_part(4, Part::Text, &encrypted, TEXT_SLACK_BYTES)
            .is_err());
    }

    #[test]
    fn decompression_is_capped() {
        const MIB: u64 = 1 << 20;
        let secrets = derive_secrets(&new_link_secret(false), &[5; 12], None).unwrap();
        let refused = |result: Result<Vec<u8>, Error>| matches!(result, Err(Error::Refused(message)) if message.contains("decompresses"));

        // 4 MiB of zeros deflate to a few KiB and must not come back out.
        let zeros = vec![0u8; 4 * MIB as usize];
        let bomb = secrets.encrypt_part(Part::Text, &zeros).unwrap();
        assert!(bomb.len() < 16 * 1024, "{}", bomb.len());
        assert!(refused(secrets.decrypt_part(4, Part::Text, &bomb, MIB)));
        assert!(refused(secrets.decrypt_part(
            4,
            Part::Text,
            &bomb,
            4 * MIB - 1
        )));
        assert_eq!(
            secrets.decrypt_part(4, Part::Text, &bomb, 4 * MIB).unwrap(),
            zeros,
            "room for exactly its size"
        );

        // A normal paste passes the same cap.
        let text = "fn main() {\n    println!(\"hi\");\n}\n".repeat(2000);
        let part = secrets.encrypt_part(Part::Text, text.as_bytes()).unwrap();
        assert_eq!(
            secrets.decrypt_part(4, Part::Text, &part, MIB).unwrap(),
            text.as_bytes()
        );
        let bomb = secrets
            .encrypt_part(Part::Title, &vec![0u8; 200 * 1024])
            .unwrap();
        assert!(refused(secrets.decrypt_part(
            4,
            Part::Title,
            &bomb,
            SMALL_PART_BYTES
        )));

        // v3: deflated, except pastes from before compression, which still
        // open; a bomb isn't handed back as raw bytes.
        let v3 = |plain: &[u8]| secrets.encrypt_raw(&secrets.part_iv(Part::Text), plain);
        assert!(refused(secrets.decrypt_part(
            3,
            Part::Text,
            &v3(&deflate(&zeros)),
            MIB
        )));
        assert_eq!(
            secrets
                .decrypt_part(3, Part::Text, &v3(&deflate(b"v3 text")), MIB)
                .unwrap(),
            b"v3 text"
        );
        assert_eq!(
            secrets
                .decrypt_part(3, Part::Text, &v3(b"plain old text"), MIB)
                .unwrap(),
            b"plain old text"
        );
    }

    fn encrypt_file(secrets: &Secrets, file: &[u8]) -> Vec<Vec<u8>> {
        let size = file.len() as u64;
        (0..Secrets::file_chunk_count(size))
            .map(|i| {
                let mut read = |offset: u64, buf: &mut [u8]| {
                    buf.copy_from_slice(&file[offset as usize..offset as usize + buf.len()]);
                    Ok(())
                };
                secrets.encrypt_file_chunk(size, i, &mut read).unwrap().0
            })
            .collect()
    }

    #[test]
    fn files_round_trip_in_chunks() {
        let secrets = derive_secrets(&new_link_secret(false), &[3; 12], None).unwrap();
        for size in [0usize, 1, 5000, (1 << 20) - 8, (1 << 20) - 7, 3 << 20] {
            let file: Vec<u8> = (0..size).map(|i| (i * 31 % 251) as u8).collect();
            let chunks = encrypt_file(&secrets, &file);
            let total: usize = chunks.iter().map(Vec::len).sum();
            assert_eq!(
                total as u64,
                format::encrypted_file_len(size as u64),
                "{size}"
            );
            let joined = chunks.concat();
            for piece in [7, 100_000, ENCRYPTED_CHUNK, 5 << 20] {
                let mut out = Vec::new();
                let mut decryptor = FileDecryptor::new(&secrets, &mut out);
                for bytes in joined.chunks(piece) {
                    decryptor.push(bytes).unwrap();
                }
                assert_eq!(decryptor.finish().unwrap(), size as u64);
                assert!(out == file, "{size} in {piece}-byte pieces");
            }
        }
    }

    #[test]
    fn tampered_files_are_refused() {
        let secrets = derive_secrets(&new_link_secret(false), &[3; 12], None).unwrap();
        let file = vec![9u8; 3 << 20];
        let chunks = encrypt_file(&secrets, &file);
        let fails = |chunks: Vec<Vec<u8>>| {
            let mut decryptor = FileDecryptor::new(&secrets, std::io::sink());
            decryptor
                .push(&chunks.concat())
                .and_then(|_| decryptor.finish())
                .is_err()
        };
        assert!(fails(vec![
            chunks[1].clone(),
            chunks[0].clone(),
            chunks[2].clone(),
            chunks[3].clone()
        ]));
        assert!(fails(chunks[..3].to_vec()), "dropped last chunk");
        let mut flipped = chunks.clone();
        flipped[1][10] ^= 1;
        assert!(fails(flipped));
    }
}
