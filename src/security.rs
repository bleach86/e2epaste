//! Response headers: security policy on every response, and caching rules
//! (long-lived for /public assets, never stored for anything holding a paste).

use rocket::fairing::{Fairing, Info, Kind};
use rocket::http::Header;
use rocket::{Request, Response};

/// Scripts, styles, fonts and requests only from this site, and no inline
/// script or style, so injected markup can't run code that reads the key from
/// the link. `data:` images are Bootstrap's inline SVG icons and the QR code;
/// `blob:` is for downloads made in the browser.
const CONTENT_SECURITY_POLICY: &str = "default-src 'none'; script-src 'self'; style-src 'self'; \
     img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; manifest-src 'self'; \
     form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

/// Paths whose responses hold paste data or paste IDs, which browsers and
/// proxies must not keep: a burned paste shouldn't survive in a cache.
const PRIVATE_PATHS: [&str; 5] = ["/paste/", "/s/", "/share/", "/delete/", "/api/"];

pub struct SecurityHeaders {
    /// Send Strict-Transport-Security; only when site_url is https.
    pub hsts: bool,
}

#[rocket::async_trait]
impl Fairing for SecurityHeaders {
    fn info(&self) -> Info {
        Info {
            name: "Security and cache headers",
            kind: Kind::Response,
        }
    }

    async fn on_response<'r>(&self, req: &'r Request<'_>, res: &mut Response<'r>) {
        let path = req.uri().path();
        let public_asset = path.starts_with("/public/");

        res.set_header(Header::new("Content-Security-Policy", CONTENT_SECURITY_POLICY));
        res.set_header(Header::new("X-Content-Type-Options", "nosniff"));
        res.set_header(Header::new("X-Frame-Options", "DENY"));
        // Paste IDs are in the path; don't pass them on to other sites.
        res.set_header(Header::new("Referrer-Policy", "no-referrer"));
        res.set_header(Header::new(
            "Permissions-Policy",
            "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
        ));
        res.set_header(Header::new("Cross-Origin-Opener-Policy", "same-origin"));
        // Static assets stay embeddable (link previews use the logo).
        if !public_asset {
            res.set_header(Header::new("Cross-Origin-Resource-Policy", "same-origin"));
        }
        if self.hsts {
            res.set_header(Header::new("Strict-Transport-Security", "max-age=31536000"));
        }

        if public_asset {
            res.set_header(Header::new("Cache-Control", "public, max-age=15552000"));
        } else if PRIVATE_PATHS.iter().any(|prefix| path.starts_with(prefix)) {
            res.set_header(Header::new("Cache-Control", "no-store"));
        }
    }
}
