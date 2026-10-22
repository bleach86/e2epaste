//! Browser-side tool pages under /tools. Each tool has its own page (template
//! `tools/<slug>`, script `/public/js/dist/tools/<slug>.js`) so it can rank for
//! its own searches; the hub pages link to them. A tool can also have
//! variants: the same tool under another address, with its own title and
//! heading, for a common search such as "hex to decimal".

use serde::Serialize;

use crate::PageMeta;

#[derive(Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ToolGroup {
    Password,
    Strings,
    Numbers,
    Security,
}

#[derive(Serialize)]
pub struct Tool {
    pub slug: &'static str,
    pub name: &'static str,
    /// One line shown under the page heading and on hub cards.
    pub summary: &'static str,
    pub group: ToolGroup,
    pub page: PageMeta,
}

/// A tool under another address, e.g. the number base converter as "Hex to
/// Decimal Converter" at /tools/hex-to-decimal. Not listed in menus; in the
/// sitemap, and linked from the tool's own page.
#[derive(Serialize)]
pub struct ToolVariant {
    pub slug: &'static str,
    /// The tool it shows.
    pub tool: &'static str,
    pub name: &'static str,
    pub summary: &'static str,
    /// Tool-specific settings for its script, e.g. which field to start in.
    pub from: &'static str,
    pub to: &'static str,
    pub page: PageMeta,
}

#[derive(Serialize)]
pub struct ToolHub {
    pub group: ToolGroup,
    pub name: &'static str,
    pub path: &'static str,
    pub intro: &'static str,
    pub page: PageMeta,
}

pub static HUBS: [ToolHub; 4] = [
    ToolHub {
        group: ToolGroup::Password,
        name: "Password Tools",
        path: "/tools/password",
        intro: "Generate strong random passwords and check how hard a password is to crack.",
        page: PageMeta {
            title: "Password Tools: Generator & Strength Checker - {site}",
            description: "Free password tools that run entirely in your browser: generate strong \
                random passwords and check password strength. Nothing is sent to the server.",
            canonical: Some("/tools/password"),
        },
    },
    ToolHub {
        group: ToolGroup::Strings,
        name: "String Tools",
        path: "/tools/strings",
        intro: "Encode, decode, count and transform text.",
        page: PageMeta {
            title: "String Tools: Base64, Hex, Binary, Character Counter & More - {site}",
            description:
                "Free text tools that run entirely in your browser: Base64, hex and binary \
                converters, a character and word counter, reverse text, random case and more.",
            canonical: Some("/tools/strings"),
        },
    },
    ToolHub {
        group: ToolGroup::Numbers,
        name: "Number Tools",
        path: "/tools/numbers",
        intro: "Convert numbers between bases, Unix timestamps to dates, and file sizes between units.",
        page: PageMeta {
            title: "Number Tools: Base, Timestamp & Byte Size Converters - {site}",
            description: "Free number tools that run entirely in your browser: convert between \
                decimal, hex, binary and octal, Unix timestamps and dates, and bytes, MB, GB and GiB.",
            canonical: Some("/tools/numbers"),
        },
    },
    ToolHub {
        group: ToolGroup::Security,
        name: "Security Tools",
        path: "/tools/security",
        intro: "Decode JWTs, make hashes and checksums, and generate UUIDs and random tokens. \
            Secrets stay on your device.",
        page: PageMeta {
            title: "Security Tools: JWT Decoder, Hash Generator & UUID Generator - {site}",
            description: "Free security tools that run entirely in your browser, so tokens, keys and \
                files never leave your device: a JWT decoder and verifier, MD5 and SHA hashes, and \
                UUID and random token generators.",
            canonical: Some("/tools/security"),
        },
    },
];

pub static TOOLS: [Tool; 15] = [
    Tool {
        slug: "password-generator",
        name: "Password Generator",
        summary: "Create a strong random password.",
        group: ToolGroup::Password,
        page: PageMeta {
            title: "Strong Random Password Generator - {site}",
            description: "Generate strong, random passwords up to 128 characters, with or without \
                symbols. Made in your browser with a cryptographically secure random generator.",
            canonical: Some("/tools/password-generator"),
        },
    },
    Tool {
        slug: "password-strength",
        name: "Password Strength Checker",
        summary: "See how long a password would take to crack, and how to improve it.",
        group: ToolGroup::Password,
        page: PageMeta {
            title: "Password Strength Checker - {site}",
            description: "Check how strong a password really is. Detects common passwords, words, \
                names, keyboard patterns and repeats, and estimates crack time. Runs in your browser.",
            canonical: Some("/tools/password-strength"),
        },
    },
    Tool {
        slug: "character-counter",
        name: "Character Counter",
        summary: "Count characters, bytes, words, lines and unique words.",
        group: ToolGroup::Strings,
        page: PageMeta {
            title: "Character, Word & Line Counter - {site}",
            description: "Count characters, UTF-8 bytes, words, lines, unique words and unique \
                characters as you type. Emoji count as one character. Runs in your browser.",
            canonical: Some("/tools/character-counter"),
        },
    },
    Tool {
        slug: "base64",
        name: "Base64 Encoder & Decoder",
        summary: "Encode text to Base64 or decode Base64 back to text.",
        group: ToolGroup::Strings,
        page: PageMeta {
            title: "Base64 Encode & Decode Online - {site}",
            description: "Encode text to Base64 and decode Base64 to text, with full UTF-8 support \
                and URL-safe Base64 decoding. Runs entirely in your browser.",
            canonical: Some("/tools/base64"),
        },
    },
    Tool {
        slug: "hex",
        name: "Text to Hex Converter",
        summary: "Convert text to hexadecimal and hex back to text.",
        group: ToolGroup::Strings,
        page: PageMeta {
            title: "Text to Hex & Hex to Text Converter - {site}",
            description: "Convert text to hexadecimal (UTF-8 bytes) and hex back to text. Accepts \
                spaces, colons and 0x prefixes. Runs entirely in your browser.",
            canonical: Some("/tools/hex"),
        },
    },
    Tool {
        slug: "binary",
        name: "Text to Binary Converter",
        summary: "Convert text to binary and binary back to text.",
        group: ToolGroup::Strings,
        page: PageMeta {
            title: "Text to Binary & Binary to Text Converter - {site}",
            description: "Convert text to 8-bit binary (UTF-8 bytes) and binary back to text. \
                Runs entirely in your browser.",
            canonical: Some("/tools/binary"),
        },
    },
    Tool {
        slug: "reverse-text",
        name: "Reverse Text",
        summary: "Write text backwards, character by character.",
        group: ToolGroup::Strings,
        page: PageMeta {
            title: "Reverse Text Generator - {site}",
            description: "Reverse text so it reads backwards. Emoji and accented letters stay \
                intact. Runs entirely in your browser.",
            canonical: Some("/tools/reverse-text"),
        },
    },
    Tool {
        slug: "random-case",
        name: "Random Case Converter",
        summary: "Turn text into rAnDoM cAsE.",
        group: ToolGroup::Strings,
        page: PageMeta {
            title: "Random Case Converter (rAnDoM cAsE) - {site}",
            description: "Convert text to random upper and lower case letters, like \"mocking\" \
                text. Runs entirely in your browser.",
            canonical: Some("/tools/random-case"),
        },
    },
    Tool {
        slug: "count-occurrences",
        name: "Count Occurrences",
        summary: "Count and highlight how often a word or phrase appears in text.",
        group: ToolGroup::Strings,
        page: PageMeta {
            title: "Count Occurrences of a Word or Phrase in Text - {site}",
            description: "Count how many times a word, phrase or character appears in text, with \
                matches highlighted and an optional case-sensitive search. Runs in your browser.",
            canonical: Some("/tools/count-occurrences"),
        },
    },
    Tool {
        slug: "number-base",
        name: "Number Base Converter",
        summary: "Convert between decimal, hex, binary, octal and any base from 2 to 36.",
        group: ToolGroup::Numbers,
        page: PageMeta {
            title: "Number Base Converter: Decimal, Hex, Binary & Octal - {site}",
            description: "Convert numbers between decimal, hexadecimal, binary, octal and any base \
                from 2 to 36, as you type. Numbers of any size, and two's complement for \
                negatives. Runs entirely in your browser.",
            canonical: Some("/tools/number-base"),
        },
    },
    Tool {
        slug: "unix-timestamp",
        name: "Unix Timestamp Converter",
        summary: "Convert Unix (epoch) timestamps to dates, and dates to timestamps.",
        group: ToolGroup::Numbers,
        page: PageMeta {
            title: "Unix Timestamp Converter (Epoch Time to Date) - {site}",
            description: "Convert Unix epoch timestamps in seconds, milliseconds, microseconds or \
                nanoseconds to a date in UTC and your time zone, and dates back to timestamps. \
                Shows the current Unix time. Runs entirely in your browser.",
            canonical: Some("/tools/unix-timestamp"),
        },
    },
    Tool {
        slug: "byte-size",
        name: "Byte Size Converter",
        summary: "Convert between bytes, KB, MB, GB and TB, and KiB, MiB, GiB and TiB.",
        group: ToolGroup::Numbers,
        page: PageMeta {
            title: "Byte Size Converter: KB, MB, GB, TB, KiB, MiB, GiB - {site}",
            description: "Convert file and disk sizes between bytes, KB, MB, GB, TB and PB, the \
                binary KiB, MiB, GiB and TiB, and bits. Explains why a 1 TB drive shows as 931 GB. \
                Runs entirely in your browser.",
            canonical: Some("/tools/byte-size"),
        },
    },
    Tool {
        slug: "jwt-decoder",
        name: "JWT Decoder",
        summary: "Read a JSON Web Token's header and claims, and check its signature.",
        group: ToolGroup::Security,
        page: PageMeta {
            title: "JWT Decoder & Verifier - {site}",
            description: "Decode a JSON Web Token (JWT) to read its header and claims, see when it \
                expires, and verify its signature with a secret or public key. Runs entirely in your \
                browser: your token is never sent anywhere.",
            canonical: Some("/tools/jwt-decoder"),
        },
    },
    Tool {
        slug: "hash-generator",
        name: "Hash Generator",
        summary: "MD5, SHA-1, SHA-256, SHA-512 and more, for text or a file.",
        group: ToolGroup::Security,
        page: PageMeta {
            title: "Hash Generator: MD5, SHA-1, SHA-256, SHA-512 for Text & Files - {site}",
            description: "Make MD5, SHA-1, SHA-256, SHA-512, SHA-3 and BLAKE3 hashes and HMACs of \
                text or files, and check a download against its published checksum. Files are \
                hashed in your browser and never uploaded.",
            canonical: Some("/tools/hash-generator"),
        },
    },
    Tool {
        slug: "uuid-generator",
        name: "UUID & Random Token Generator",
        summary: "Generate UUIDs (v4 and v7) and random tokens for keys and secrets.",
        group: ToolGroup::Security,
        page: PageMeta {
            title: "UUID Generator (v4 & v7) and Random Token Generator - {site}",
            description: "Generate random UUIDs (v4) and time-ordered UUIDs (v7) in bulk, inspect a \
                UUID, and make random tokens in hex, base64 or letters and digits for API keys and \
                secrets. Runs entirely in your browser.",
            canonical: Some("/tools/uuid-generator"),
        },
    },
];

/// A "<from> to <to> Converter" variant of `tool`. `summary` and
/// `description` follow "Convert <from> to <to>".
macro_rules! variant {
    ($tool:literal, $slug:literal, $from:literal, $to:literal, $from_name:literal,
     $to_name:literal, $summary:literal, $description:literal) => {
        ToolVariant {
            slug: $slug,
            tool: $tool,
            name: concat!($from_name, " to ", $to_name, " Converter"),
            summary: concat!("Convert ", $from_name, " to ", $to_name, $summary),
            from: $from,
            to: $to,
            page: PageMeta {
                title: concat!($from_name, " to ", $to_name, " Converter - {site}"),
                description: concat!("Convert ", $from_name, " to ", $to_name, $description),
                canonical: Some(concat!("/tools/", $slug)),
            },
        }
    };
}

macro_rules! base_variant {
    ($slug:literal, $from:literal, $to:literal, $from_name:literal, $to_name:literal) => {
        variant!(
            "number-base",
            $slug,
            $from,
            $to,
            $from_name,
            $to_name,
            " as you type, with the other bases alongside.",
            " numbers instantly, as you type. Numbers of any size, prefixes like 0x and 0b \
            accepted, and two's complement for negatives. Runs entirely in your browser."
        )
    };
}

macro_rules! bytes_variant {
    ($slug:literal, $from:literal, $to:literal) => {
        variant!(
            "byte-size",
            $slug,
            $from,
            $to,
            $from,
            $to,
            ", in both decimal (1000) and binary (1024) units.",
            " instantly, in both decimal (1000) and binary (1024) units, with every other \
            size alongside. Runs entirely in your browser."
        )
    };
}

/// "<name> Hash Generator": the hash generator with `algorithm` first.
macro_rules! hash_variant {
    ($slug:literal, $algorithm:literal, $name:literal) => {
        ToolVariant {
            slug: $slug,
            tool: "hash-generator",
            name: concat!($name, " Hash Generator"),
            summary: concat!("Make the ", $name, " hash of text or a file."),
            from: $algorithm,
            to: "",
            page: PageMeta {
                title: concat!($name, " Hash Generator for Text & Files - {site}"),
                description: concat!(
                    "Make the ",
                    $name,
                    " hash of text or a file, or check a download against its ",
                    $name,
                    " checksum. Files are hashed in your browser and never uploaded."
                ),
                canonical: Some(concat!("/tools/", $slug)),
            },
        }
    };
}

pub static VARIANTS: [ToolVariant; 18] = [
    base_variant!("hex-to-decimal", "16", "10", "Hex", "Decimal"),
    base_variant!("decimal-to-hex", "10", "16", "Decimal", "Hex"),
    base_variant!("binary-to-decimal", "2", "10", "Binary", "Decimal"),
    base_variant!("decimal-to-binary", "10", "2", "Decimal", "Binary"),
    base_variant!("hex-to-binary", "16", "2", "Hex", "Binary"),
    base_variant!("binary-to-hex", "2", "16", "Binary", "Hex"),
    base_variant!("octal-to-decimal", "8", "10", "Octal", "Decimal"),
    base_variant!("decimal-to-octal", "10", "8", "Decimal", "Octal"),
    bytes_variant!("kb-to-mb", "KB", "MB"),
    bytes_variant!("mb-to-gb", "MB", "GB"),
    bytes_variant!("gb-to-mb", "GB", "MB"),
    bytes_variant!("gb-to-tb", "GB", "TB"),
    bytes_variant!("tb-to-gb", "TB", "GB"),
    bytes_variant!("gb-to-gib", "GB", "GiB"),
    hash_variant!("md5-hash", "md5", "MD5"),
    hash_variant!("sha1-hash", "sha1", "SHA-1"),
    hash_variant!("sha256-hash", "sha256", "SHA-256"),
    hash_variant!("sha512-hash", "sha512", "SHA-512"),
];

/// A hub with its tools, for templates that list tools by group.
#[derive(Serialize)]
pub struct HubListing {
    pub hub: &'static ToolHub,
    pub tools: Vec<&'static Tool>,
}

pub fn listings() -> Vec<HubListing> {
    HUBS.iter()
        .map(|hub| HubListing {
            hub,
            tools: TOOLS.iter().filter(|t| t.group == hub.group).collect(),
        })
        .collect()
}

pub fn find_tool(slug: &str) -> Option<&'static Tool> {
    TOOLS.iter().find(|t| t.slug == slug)
}

/// The tool at /tools/<slug>, and the variant when it's one.
pub fn find_page(slug: &str) -> Option<(&'static Tool, Option<&'static ToolVariant>)> {
    if let Some(tool) = find_tool(slug) {
        return Some((tool, None));
    }
    let variant = VARIANTS.iter().find(|v| v.slug == slug)?;
    Some((find_tool(variant.tool)?, Some(variant)))
}

/// A tool's variants, for links from its page.
pub fn variants_of(tool: &str) -> Vec<&'static ToolVariant> {
    VARIANTS.iter().filter(|v| v.tool == tool).collect()
}

pub fn hub(group: ToolGroup) -> &'static ToolHub {
    HUBS.iter()
        .find(|h| h.group == group)
        .expect("every group has a hub")
}

/// Paths of every hub and tool page, for sitemap.xml.
pub fn sitemap_paths() -> impl Iterator<Item = &'static str> {
    HUBS.iter()
        .map(|h| h.path)
        .chain(TOOLS.iter().filter_map(|t| t.page.canonical))
        .chain(VARIANTS.iter().filter_map(|v| v.page.canonical))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_tool_and_variant_is_found() {
        for tool in &TOOLS {
            assert!(matches!(find_page(tool.slug), Some((t, None)) if t.slug == tool.slug));
        }
        for variant in &VARIANTS {
            assert!(
                find_tool(variant.tool).is_some(),
                "{} has no tool",
                variant.slug
            );
            assert!(
                find_tool(variant.slug).is_none(),
                "{} is also a tool",
                variant.slug
            );
            assert!(
                matches!(find_page(variant.slug), Some((_, Some(v))) if v.slug == variant.slug)
            );
        }
        for hub in &HUBS {
            assert!(
                TOOLS.iter().any(|t| t.group == hub.group),
                "{} is empty",
                hub.name
            );
        }
    }
}
