//! Browser-side tool pages under /tools. Each tool has its own page (template
//! `tools/<slug>`, script `/public/js/dist/tools/<slug>.js`) so it can rank for
//! its own searches; the two hub pages link to them.

use serde::Serialize;

use crate::PageMeta;

#[derive(Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ToolGroup {
    Password,
    Strings,
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

#[derive(Serialize)]
pub struct ToolHub {
    pub group: ToolGroup,
    pub name: &'static str,
    pub path: &'static str,
    pub intro: &'static str,
    pub page: PageMeta,
}

pub static HUBS: [ToolHub; 2] = [
    ToolHub {
        group: ToolGroup::Password,
        name: "Password Tools",
        path: "/tools/password",
        intro: "Generate strong random passwords and check how hard a password is to crack.",
        page: PageMeta {
            title: "Password Tools: Generator & Strength Checker - e2ePaste.XYZ",
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
            title: "String Tools: Base64, Hex, Binary, Character Counter & More - e2ePaste.XYZ",
            description: "Free text tools that run entirely in your browser: Base64, hex and binary \
                converters, a character and word counter, reverse text, random case and more.",
            canonical: Some("/tools/strings"),
        },
    },
];

pub static TOOLS: [Tool; 9] = [
    Tool {
        slug: "password-generator",
        name: "Password Generator",
        summary: "Create a strong random password.",
        group: ToolGroup::Password,
        page: PageMeta {
            title: "Strong Random Password Generator - e2ePaste.XYZ",
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
            title: "Password Strength Checker - e2ePaste.XYZ",
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
            title: "Character, Word & Line Counter - e2ePaste.XYZ",
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
            title: "Base64 Encode & Decode Online - e2ePaste.XYZ",
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
            title: "Text to Hex & Hex to Text Converter - e2ePaste.XYZ",
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
            title: "Text to Binary & Binary to Text Converter - e2ePaste.XYZ",
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
            title: "Reverse Text Generator - e2ePaste.XYZ",
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
            title: "Random Case Converter (rAnDoM cAsE) - e2ePaste.XYZ",
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
            title: "Count Occurrences of a Word or Phrase in Text - e2ePaste.XYZ",
            description: "Count how many times a word, phrase or character appears in text, with \
                matches highlighted and an optional case-sensitive search. Runs in your browser.",
            canonical: Some("/tools/count-occurrences"),
        },
    },
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

pub fn hub(group: ToolGroup) -> &'static ToolHub {
    HUBS.iter().find(|h| h.group == group).expect("every group has a hub")
}

/// Paths of every hub and tool page, for sitemap.xml.
pub fn sitemap_paths() -> impl Iterator<Item = &'static str> {
    HUBS.iter()
        .map(|h| h.path)
        .chain(TOOLS.iter().filter_map(|t| t.page.canonical))
}
