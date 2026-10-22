//! Paste links (`https://site/s/<id>#<secret>`, also `/paste/` and
//! `/share/`) and delete links (`https://site/delete/<id>#<token>`).

use url::Url;

use crate::error::Error;

pub struct PasteLink {
    /// The site, e.g. `https://paste.example.com`.
    pub site: Url,
    pub id: String,
    /// The part after `#`.
    pub secret: String,
}

pub struct DeleteLink {
    pub site: Url,
    pub id: String,
    pub token: String,
}

impl PasteLink {
    pub fn parse(link: &str) -> Result<PasteLink, Error> {
        let (site, kind, id, fragment) = split(link)?;
        if !matches!(kind.as_str(), "s" | "paste" | "share") {
            return Err(Error::Usage(format!(
                "{link:?} isn't a paste link (https://site/s/<id>#<secret>)"
            )));
        }
        let secret = fragment.ok_or_else(|| {
            Error::WrongKey("the link has no secret: everything after the # is needed".into())
        })?;
        Ok(PasteLink { site, id, secret })
    }

    pub fn url(&self) -> String {
        format!("{}s/{}#{}", self.site, self.id, self.secret)
    }
}

impl DeleteLink {
    pub fn parse(link: &str) -> Result<DeleteLink, Error> {
        let (site, kind, id, fragment) = split(link)?;
        if kind != "delete" {
            return Err(Error::Usage(format!(
                "{link:?} isn't a delete link (https://site/delete/<id>#<token>)"
            )));
        }
        let token = fragment.ok_or_else(|| {
            Error::WrongKey("the delete link has no token: everything after the # is needed".into())
        })?;
        Ok(DeleteLink { site, id, token })
    }
}

/// The site, the path's first segment, the ID and the fragment.
fn split(link: &str) -> Result<(Url, String, String, Option<String>), Error> {
    let bad = || Error::Usage(format!("{link:?} isn't an e2ePaste link"));
    let url = Url::parse(link.trim()).map_err(|_| bad())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(bad());
    }
    let segments: Vec<&str> = url.path_segments().map(|s| s.collect()).unwrap_or_default();
    let [kind, id] = segments.as_slice() else {
        return Err(bad());
    };
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(bad());
    }
    let fragment = url.fragment().filter(|f| !f.is_empty()).map(str::to_string);
    let mut site = url.clone();
    site.set_path("/");
    site.set_query(None);
    site.set_fragment(None);
    Ok((site, kind.to_string(), id.to_string(), fragment))
}

/// A site address from `--server`, e.g. `https://paste.example.com`.
/// Where new pastes go when neither --server nor E2EPASTE_SERVER says.
pub const DEFAULT_SITE: &str = "https://e2epaste.xyz/";

pub fn parse_site(server: &str) -> Result<Url, Error> {
    let mut url = Url::parse(server.trim())
        .ok()
        .filter(|url| matches!(url.scheme(), "http" | "https") && url.host().is_some())
        .ok_or_else(|| {
            Error::Usage(format!(
                "{server:?} isn't a site address; use one like https://paste.example.com"
            ))
        })?;
    url.set_path("/");
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_paste_links() {
        let link = PasteLink::parse("https://paste.example.com/s/Ab3dE5gH#secret").unwrap();
        assert_eq!(link.site.as_str(), "https://paste.example.com/");
        assert_eq!(
            (link.id.as_str(), link.secret.as_str()),
            ("Ab3dE5gH", "secret")
        );
        assert!(PasteLink::parse("http://localhost:8001/paste/abc#x").is_ok());
        assert!(matches!(
            PasteLink::parse("https://x.example/s/abc"),
            Err(Error::WrongKey(_))
        ));
        assert!(PasteLink::parse("https://x.example/delete/abc#t").is_err());
        assert!(PasteLink::parse("https://x.example/s/../#t").is_err());
        assert!(PasteLink::parse("ftp://x.example/s/abc#t").is_err());
    }

    #[test]
    fn parses_delete_links() {
        let link = DeleteLink::parse("https://x.example/delete/abc123#tok").unwrap();
        assert_eq!((link.id.as_str(), link.token.as_str()), ("abc123", "tok"));
        assert!(DeleteLink::parse("https://x.example/s/abc123#tok").is_err());
    }

    #[test]
    fn parses_sites() {
        assert_eq!(
            parse_site("https://paste.example.com/some/path")
                .unwrap()
                .as_str(),
            "https://paste.example.com/"
        );
        assert!(parse_site("paste.example.com").is_err());
    }
}
