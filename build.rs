use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::Path;
use std::process::Command;

const DIST_DIR: &str = "static/js/dist";

// Installs node_modules and runs webpack so `cargo build` / `cargo run`
// produce the bundles in static/js/dist. Set SKIP_NPM_BUILD=1 to skip.
fn main() {
    for path in [
        "package.json",
        "package-lock.json",
        "webpack.config.js",
        "js",
    ] {
        println!("cargo:rerun-if-changed={path}");
    }
    println!("cargo:rerun-if-env-changed=SKIP_NPM_BUILD");

    if std::env::var_os("SKIP_NPM_BUILD").is_some() {
        println!("cargo:warning=SKIP_NPM_BUILD set, skipping npm install and webpack");
    } else {
        npm(&["ci", "--no-audit", "--no-fund"]);
        npm(&["run", "build"]);
    }

    // Cache-busting query string for the bundles (?v={{ asset_version }}),
    // since /public is served with a long max-age.
    println!(
        "cargo:rustc-env=ASSET_VERSION={:x}",
        hash_dir(Path::new(DIST_DIR))
    );
}

fn npm(args: &[&str]) {
    let npm = if cfg!(windows) { "npm.cmd" } else { "npm" };
    let status = Command::new(npm)
        .args(args)
        .status()
        .unwrap_or_else(|e| panic!("failed to run `{npm}` (is Node.js installed?): {e}"));

    if !status.success() {
        panic!("`{npm} {}` failed with {status}", args.join(" "));
    }
}

fn hash_dir(dir: &Path) -> u64 {
    let mut hasher = DefaultHasher::new();
    hash_dir_into(dir, dir, &mut hasher);
    hasher.finish()
}

// Hashes every file under `dir` (recursively, in a stable order) by its path
// relative to `root` and its contents.
fn hash_dir_into(root: &Path, dir: &Path, hasher: &mut DefaultHasher) {
    let mut entries: Vec<_> = std::fs::read_dir(dir)
        .map(|rd| rd.filter_map(Result::ok).map(|e| e.path()).collect())
        .unwrap_or_default();
    entries.sort();

    for path in entries {
        if path.is_dir() {
            hash_dir_into(root, &path, hasher);
        } else if let Ok(contents) = std::fs::read(&path) {
            path.strip_prefix(root).unwrap_or(&path).hash(hasher);
            contents.hash(hasher);
        }
    }
}
