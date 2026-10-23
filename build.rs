use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::Path;
use std::process::Command;
use std::time::SystemTime;

const DIST_DIR: &str = "static/js/dist";

// Installs node_modules and runs webpack so `cargo build` / `cargo run`
// produce the bundles in static/js/dist. Set SKIP_NPM_BUILD=1 to skip, as
// .vscode/settings.json does for rust-analyzer: two builds at once clash over
// node_modules, which `npm ci` deletes and reinstalls.
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
        if !node_modules_current() {
            npm(&["ci", "--no-audit", "--no-fund"]);
        }
        // This also reruns for any change to the checkout (see git_commit),
        // so webpack only runs when its own inputs changed.
        let stamp = Path::new(&std::env::var("OUT_DIR").unwrap()).join("webpack.stamp");
        if !bundles_current(&stamp) {
            npm(&["run", "build"]);
            std::fs::write(&stamp, b"").expect("can't write the webpack stamp");
        }
    }

    // Cache-busting query string for the bundles (?v={{ asset_version }}),
    // since /public is served with a long max-age.
    println!(
        "cargo:rustc-env=ASSET_VERSION={:x}",
        hash_dir(Path::new(DIST_DIR))
    );

    // The commit the site is built from, for the footer, and whether the
    // checkout had changes to it. E2EPASTE_COMMIT gives the commit where
    // there's no git checkout (the Docker build).
    println!("cargo:rerun-if-env-changed=E2EPASTE_COMMIT");
    let (commit, dirty) = match std::env::var("E2EPASTE_COMMIT") {
        Ok(commit) if !commit.is_empty() => (commit, false),
        _ => git_commit().unwrap_or_default(),
    };
    println!("cargo:rustc-env=BUILD_COMMIT={commit}");
    println!(
        "cargo:rustc-env=BUILD_DIRTY={}",
        if dirty { "1" } else { "" }
    );
}

fn git(args: &[&str]) -> Option<String> {
    // No optional locks: `git status` would otherwise rewrite the index.
    let out = Command::new("git")
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

// HEAD's short hash, and whether any tracked file differs from it, or None
// outside a git checkout. Reruns when HEAD moves (a commit, a checkout or a
// pull) or any tracked file changes, so the "dirty" mark is never stale.
fn git_commit() -> Option<(String, bool)> {
    let commit = git(&["rev-parse", "--short", "HEAD"])?;
    let dirty = !git(&["status", "--porcelain", "--untracked-files=no"])?.is_empty();

    let mut watched = Vec::new();
    for path in ["HEAD", "packed-refs"] {
        watched.extend(git(&["rev-parse", "--git-path", path]));
    }
    if let Some(branch) = git(&["symbolic-ref", "-q", "HEAD"]) {
        watched.extend(git(&["rev-parse", "--git-path", &branch]));
    }
    watched.extend(git(&["ls-files"])?.lines().map(String::from));
    // Only files that exist: cargo reruns this every build for a missing one
    // (a branch only in packed-refs, a deleted file).
    for path in watched.iter().filter(|p| Path::new(p).exists()) {
        println!("cargo:rerun-if-changed={path}");
    }
    Some((commit, dirty))
}

// Whether the bundles were built, into this target directory, after the
// last change to webpack's inputs.
fn bundles_current(stamp: &Path) -> bool {
    let Some(built) = modified(stamp) else {
        return false;
    };
    if !Path::new(DIST_DIR).is_dir() {
        return false;
    }
    let mut inputs = vec![
        Path::new("package.json").to_path_buf(),
        Path::new("package-lock.json").to_path_buf(),
        Path::new("webpack.config.js").to_path_buf(),
        Path::new("node_modules/.package-lock.json").to_path_buf(),
    ];
    collect_files(Path::new("js"), &mut inputs);
    inputs
        .iter()
        .all(|path| modified(path).is_some_and(|m| m <= built))
}

fn modified(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path).ok()?.modified().ok()
}

fn collect_files(dir: &Path, files: &mut Vec<std::path::PathBuf>) {
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_files(&path, files);
        } else {
            files.push(path);
        }
    }
}

// Whether node_modules was installed from the current package-lock.json:
// npm writes node_modules/.package-lock.json on every install.
fn node_modules_current() -> bool {
    match (
        modified(Path::new("node_modules/.package-lock.json")),
        modified(Path::new("package-lock.json")),
    ) {
        (Some(installed), Some(lock)) => installed >= lock,
        _ => false,
    }
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
