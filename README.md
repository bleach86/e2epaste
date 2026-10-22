# e2ePaste.XYZ

[![CI](https://github.com/bleach86/e2epaste/actions/workflows/ci.yml/badge.svg)](https://github.com/bleach86/e2epaste/actions/workflows/ci.yml)

An end-to-end encrypted pastebin for text and files. Everything is encrypted in your browser before it's
uploaded, and the key never reaches the server, so the server only ever stores data it can't read.

**Live at [e2epaste.xyz](https://e2epaste.xyz)**

## Features

- **End-to-end encryption.** Pastes, titles, file attachments and file names are encrypted with AES-256-GCM
  in the browser.
- **Optional password.** The paste can't be decrypted without it, even by someone who has the link.
- **Expiry and view limits.** Pastes expire after 10 minutes to 1 year. Set a view limit of 1 for
  "burn after reading". Views are counted by the server, and the paste is deleted on its last one.
- **Delete links.** The creator gets a separate link to delete the paste early.
- **File attachments** up to 25 MB, alongside up to 1 MB of text. Both limits are settings, and a site
  can turn attachments off.
- **Syntax highlighting** for 35 languages, live while you type, with the language detected automatically.
  The guess is made in the browser, so the server doesn't learn what kind of content a paste holds.
- **Markdown rendering.** Markdown pastes can be viewed rendered or as source. Rendering is sanitized: no
  raw HTML, no scripts, and remote images are shown as links so they can't track who opens the paste.
- **Short links and QR codes** for sharing. Link previews in chat apps show a generic card, never the
  content.
- **No accounts, no tracking**, and no third-party requests: fonts and scripts are served by the site itself.
- **Browser-only tools:** a password generator and strength checker, Base64, hex and binary converters, a
  character counter and more. Like pastes, nothing you enter is sent to the server.
- **A command-line client, `e2ep`,** for scripts and AI agents (see below).

## Command-line client

[`e2ep`](cli/README.md) creates, reads, checks and deletes pastes from the terminal, encrypting and
decrypting on your machine in the same format as the site's pages:

```sh
cat error.log | e2ep --burn                          # to e2epaste.xyz; --server for another site
e2ep get 'https://paste.example.com/s/Ab3dE5gH#…' --attachment-dir .
```

It's built for scripts and AI agents: results on stdout, `--json` for everything, an exit code for each
kind of failure, and checks before opening so a failed `get` never uses up a view. `e2ep mcp` runs it as
an MCP server, so Claude Code, Claude Desktop and other AI apps can use it as tools, with the server and
the files it may touch fixed when you set it up. Builds for Linux,
macOS and Windows are on the [releases](https://github.com/bleach86/e2epaste/releases) page. Paste
pages point programs that fetch them at `e2ep`, in a `<noscript>` notice and their `<head>`, and
`/llms.txt` explains the site to AI agents.

## How it works

When you create a paste, your browser:

1. generates a random 128-bit secret,
2. derives an AES-256 key from it with HKDF-SHA256 (if you set a password, it's stretched with
   PBKDF2-SHA256, 600,000 rounds, and mixed in),
3. compresses the text, title and file name, pads each to a rounded size, then encrypts each with
   AES-256-GCM using its own IV. An attachment is padded and encrypted in 1 MiB chunks as it uploads
   (it isn't compressed, so the server can't tell how compressible it is),
4. derives a separate _access proof_ from the same secret (and password) with different HKDF info, and
5. uploads the encrypted data and a SHA-256 hash of the access proof.

The secret goes in the link after the `#`, for example `https://e2epaste.xyz/s/Ab3dE5gH#<secret>`.
Browsers never send the part after `#` to the server, so the server never has the key.

When someone opens the link, the page itself holds none of the paste. Their browser derives the key and the
access proof, and sends the proof to the server. The server checks it against the stored hash, counts the
view and only then sends the encrypted paste, which the browser decrypts locally. So:

- knowing a paste's ID (from a log, say) isn't enough to download it or use up its views,
- a broken link or a wrong password is refused without using a view,
- the encrypted paste can't be downloaded to guess a password offline: guesses have to go through the
  server, which limits failed attempts per IP.

The proof can't be turned back into the secret, the password or the key. Each view also comes with a
one-time ticket for downloading the attachment, so attachments can't be fetched without a view either.

The server does store some information it needs to work: rounded sizes, when the paste was created and
expires, the view count and limit, whether it has an attachment, and the hashes of the access proof and the
creator's delete link. Like any website, it can also see IP addresses.

It doesn't learn exact sizes, the language or whether there's a password. Every part of a paste is padded
before encryption with [Padmé](https://arxiv.org/abs/1806.03160): every short paste or file is 4 KiB, larger
ones are rounded up by at most 12%, and the title is always 512 bytes. The language is encrypted with the
title. Whether there's a password is a spare bit in the link's secret, so the link is no longer, and the
server refuses new pastes that aren't padded.

Pages are served with a strict Content Security Policy: scripts only from the site itself, with no inline
script or style. Paste pages and API responses are marked `no-store`, so browsers and proxies don't keep
copies.

**Limits of the design.** Anyone with the full link can read the paste, so it's only as private as the
channel you send the link through; a password protects against that. And as with every browser-based
encrypted service, the encryption code is delivered by the site itself, so you're trusting the server to
send unmodified code. That's why the code is open source.

The encryption code is in [`js/crypto.mjs`](js/crypto.mjs). Older paste formats (v1 and v2) are still
decrypted for existing links, and so is v3 (before padding); new pastes always use v4. Pastes created
before access proofs existed open without one, and their views are still counted by the server.

## Self-hosting

You can run your own instance with Docker or as a native binary. Either way:

- **It needs HTTPS.** Browsers only allow the Web Crypto API on HTTPS pages (and on `localhost`), so
  encryption won't work over plain HTTP. Run the server behind a reverse proxy that handles TLS, such as
  Caddy, nginx or Apache ([examples below](#https-with-a-reverse-proxy)). Visitors who reach it over plain
  HTTP get a warning banner instead of a broken page.
- **Set `site_url` to your address**, for example `https://paste.example.com`. It's used for canonical
  links, the sitemap, robots.txt and link previews. Paste links always use the address the page was
  opened at, so they work even before you set it.

### Configuration

Settings are read from [`Rocket.toml`](Rocket.toml). Any of them can be overridden with an environment
variable named `ROCKET_` plus the setting in capitals, such as `ROCKET_SITE_URL`.

| Setting                      | Default                 | What it does                                                                                                                                                  |
| ---------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `site_url`                   | `http://localhost:8001` | The site's public address: `https://` plus the domain, with no path                                                                                           |
| `site_name`                  | `site_url`'s host name  | The name in page titles, the header and link previews, e.g. `Example Paste`. Up to 40 characters                                                              |
| `source_url`                 | this repository         | Where the "source code" links point. If you run a modified copy, point it at your code                                                                        |
| `data_dir`                   | `.` (working directory) | Where the database (`e2epaste.redb`) and attachments (`file_store/`) are kept. Both are created if missing                                                    |
| `address`                    | `127.0.0.1`             | Address to listen on. The default only accepts connections from the same machine, for a reverse proxy there. Use `0.0.0.0` if the proxy is on another machine |
| `port`                       | `8001`                  | Port to listen on                                                                                                                                             |
| `ip_header`                  | `X-Real-IP`             | Header the reverse proxy puts the visitor's IP in (see [Limits](#limits))                                                                                     |
| `unlock_attempts_per_hour`   | `30`                    | Failed attempts to open or delete a paste (wrong link, password or delete link) one IP can make per hour                                                      |
| `admin_token`                | unset                   | Turns on the [admin API](#taking-a-paste-down). At least 32 characters                                                                                        |
| `max_paste_kib`              | `1024`                  | Largest paste text, in KiB (1024 is 1 MB). At most 65536                                                                                                      |
| `allow_files`                | `true`                  | Whether pastes can have an attachment                                                                                                                         |
| `max_file_mib`               | `25`                    | Largest attachment, in MiB. At most 4096. Uploads go in 1 MiB chunks, but downloads are put back together in the browser, so very large files can fail on phones |
| `pastes_per_minute`          | `10`                    | Pastes one IP can create per minute                                                                                                                           |
| `pastes_per_hour`            | `60`                    | Pastes one IP can create per hour                                                                                                                             |
| `upload_mib_per_hour`        | `250`                   | Attachment data one IP can upload per hour, in MiB. At least one attachment's worth, `max_file_mib` plus a little for padding                                  |
| `min_free_disk_mib`          | `1024`                  | New pastes are refused when the disk holding `data_dir` has less free space than this                                                                         |
| `max_attachment_storage_mib` | `0`                     | Cap on the total size of all stored attachments                                                                                                               |
| `static_dir`                 | `static`                | Front-end files, served at `/public`                                                                                                                          |
| `template_dir`               | `templates`             | Page templates                                                                                                                                                |

For the limits, `0` turns a limit off.

`static_dir` and `template_dir` are relative to the working directory, so run the server from the
repository directory or set them to absolute paths. The server prints the site URL and directories it's
using when it starts, and warns if `site_url` is still `localhost` in a release build.

### Limits

To stop one visitor from flooding the site or filling the disk, the server limits how many pastes each
IP address can create, and how much attachment data it can upload. IPv6 addresses are grouped by /64,
since one user usually has a whole /64. Only creating pastes and uploading attachments count; viewing
pastes and using the tools are never limited. A visitor over a limit is told how long to wait.

These limits are kept in memory, so they reset when the server restarts. Because they can't stop many
addresses working together, the server also stops taking new pastes when the disk is nearly full
(`min_free_disk_mib`), and can cap the total size of attachments (`max_attachment_storage_mib`).

How much one paste can hold is up to you: `max_paste_kib` for the text and `max_file_mib` for the
attachment, or `allow_files = false` to turn attachments off. The create page and the FAQ show your
limits, and the server works out the largest encrypted size from them (allowing for compression and
padding) and refuses anything bigger. Attachments are uploaded in 1 MiB chunks, so the largest request
is the paste itself, about 1.4 times `max_paste_kib`. If you raise `max_paste_kib` past a few MB, raise
your reverse proxy's request size limit to match (`client_max_body_size` in nginx, `LimitRequestBody` in
Apache).

**The reverse proxy must pass the visitor's IP.** Behind a proxy, every request comes from the proxy's
own address, so without this all visitors would share one limit. The server reads the IP from the
`X-Real-IP` header, which every [proxy example below](#https-with-a-reverse-proxy) sets. The proxy must
_overwrite_ the header rather than pass on one sent by the visitor. Also make sure visitors can't reach
the server's port directly, bypassing the proxy: the default `address` of `127.0.0.1` and the Docker
setup's `127.0.0.1:8001` port binding both take care of that.

### With Docker

You need Docker with the Compose plugin.

```sh
git clone https://github.com/bleach86/e2epaste.git
cd e2epaste
cp .env.example .env    # then set SITE_URL to your https:// address
docker compose up -d --build
```

The server is now on `127.0.0.1:8001`, reachable only from the same machine. Point your reverse proxy at
it. To use a different port, set `PORT` in `.env`.

- **Data** is kept in the Docker volume `e2epaste_e2epaste-data`, so it survives rebuilds.
- **Logs:** `docker compose logs -f`
- **Updating:** `git pull && docker compose up -d --build`
- **Backup:** stop the container so the database is consistent, then copy the volume to a tarball:

  ```sh
  docker compose stop
  docker run --rm -v e2epaste_e2epaste-data:/data -v "$PWD":/backup debian:trixie-slim \
    tar czf /backup/e2epaste-backup.tar.gz -C /data .
  docker compose start
  ```

To keep the data in a host directory instead, replace the volume in
[`docker-compose.yml`](docker-compose.yml) with a bind mount such as `./data:/data`. The container runs as
user and group 10001, so first run `mkdir data && sudo chown 10001:10001 data`.

Without Compose:

```sh
docker build -t e2epaste .
docker run -d --name e2epaste --restart unless-stopped \
  -p 127.0.0.1:8001:8001 \
  -e ROCKET_SITE_URL=https://paste.example.com \
  -v e2epaste-data:/data \
  e2epaste
```

### Native

You need:

- a recent stable [Rust](https://www.rust-lang.org/tools/install) toolchain
- [Node.js](https://nodejs.org/) 20.9 or later, with npm

`cargo build` runs `npm ci` and webpack for you (see [`build.rs`](build.rs)), so there's no separate
front-end build step.

To try it locally:

```sh
git clone https://github.com/bleach86/e2epaste.git
cd e2epaste
cargo run --release
```

Open <http://localhost:8001>. Pastes are stored in `e2epaste.redb` and `file_store/` in the repository
directory.

#### As a systemd service

[`deploy/`](deploy/) has a hardened systemd unit and an install script. The program and its files go in
`/opt/e2epaste` (read-only to the service), the data in `/var/lib/e2epaste`, and the settings, including
any admin token, in `/etc/e2epaste/e2epaste.env`, readable only by root and the service. The service
runs as its own `e2epaste` user, with no access to the rest of the system (`systemd-analyze security
e2epaste` rates it 1.2, "OK").

1. Install the build tools. On Debian 13: `sudo apt install build-essential pkg-config git nodejs npm`,
   and Rust from [rustup](https://rustup.rs) as your own user.
2. Build, as yourself:

   ```sh
   git clone https://github.com/bleach86/e2epaste.git && cd e2epaste
   cargo build --release --locked -p e2epaste
   ```

3. Install, as root. This creates the user, the directories, the settings file and the service:

   ```sh
   sudo deploy/install.sh
   ```

   To bring along an existing instance's data, stop it first and add `--data-from <its data
   directory>`: the database (`paste_db/` or `e2epaste.redb`) and `file_store/` are moved together.
4. Set at least `ROCKET_SITE_URL` in `/etc/e2epaste/e2epaste.env`, then start it and watch the log:

   ```sh
   sudo systemctl start e2epaste
   journalctl -u e2epaste -f
   ```

To update: `git pull`, build again, and run `sudo deploy/install.sh`. It installs the new build,
restarts the service, and keeps the previous binary as `/opt/e2epaste/e2epaste.previous` for going back.
[`deploy/README.md`](deploy/README.md) walks through moving a running site to a new server.

### HTTPS with a reverse proxy

Point the proxy at the port the server listens on, and have it set the `X-Real-IP` header to the
visitor's address so the [limits](#limits) work per visitor.

With [Caddy](https://caddyserver.com/), which gets a certificate automatically, the whole `Caddyfile`
is:

```
paste.example.com {
    reverse_proxy 127.0.0.1:8001 {
        header_up X-Real-IP {remote_host}
    }
}
```

With nginx, also raise the request size limit. The default of 1 MB is too small for large pastes and
attachments:

```nginx
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name paste.example.com;

    ssl_certificate     /etc/letsencrypt/live/paste.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/paste.example.com/privkey.pem;

    # Above the largest request: a paste, about 1.4 x max_paste_kib.
    # Attachments are uploaded in 1 MiB chunks.
    client_max_body_size 30m;

    location / {
        proxy_pass http://127.0.0.1:8001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

With Apache, enable the modules with `sudo a2enmod ssl proxy proxy_http headers`, then:

```apache
<VirtualHost *:443>
    ServerName paste.example.com

    SSLEngine on
    SSLCertificateFile    /etc/letsencrypt/live/paste.example.com/fullchain.pem
    SSLCertificateKeyFile /etc/letsencrypt/live/paste.example.com/privkey.pem

    ProxyPreserveHost On
    ProxyPass        / http://127.0.0.1:8001/
    ProxyPassReverse / http://127.0.0.1:8001/

    # "set" replaces any X-Real-IP the visitor sent, so it can't be faked.
    RequestHeader set X-Real-IP "expr=%{REMOTE_ADDR}"
    RequestHeader set X-Forwarded-Proto "https"

    # Above the largest request: a paste, about 1.4 x max_paste_kib.
    # Attachments are uploaded in 1 MiB chunks.
    LimitRequestBody 31457280
</VirtualHost>
```

If a CDN such as Cloudflare sits in front of the proxy, the proxy sees the CDN's address rather than the
visitor's. Configure the proxy to take the real address from the CDN first (with Apache, `mod_remoteip`;
with nginx, `set_real_ip_from`), or every visitor will share the CDN's limits.

### Taking a paste down

The server can't read pastes, but you may still need to remove one, for example after an abuse report. Set
`admin_token` (with `ROCKET_ADMIN_TOKEN`; generate one with `openssl rand -hex 32`) and restart. Then
delete a paste by its ID, the 8 characters after `/s/` or `/paste/` in its link:

```sh
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" https://paste.example.com/api/admin/delete/Ab3dE5gH
```

The reply is `{"deleted":true}`, or `{"deleted":false}` if there was no such paste. Without `admin_token`,
the admin API doesn't exist. Failed attempts count towards `unlock_attempts_per_hour`.

### Data

| Path (in `data_dir`) | Contents                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| `e2epaste.redb`      | The paste database ([redb](https://www.redb.org/)): encrypted pastes, the expiry index and site stats |
| `file_store/`        | Encrypted attachments, one file per paste                                                             |

Expired pastes can't be opened, and a cleanup every minute deletes them from disk. Back up the database
and `file_store/` together, with the server stopped.

### Upgrading from a version before redb

Versions before October 2026 stored pastes in a [sled](https://github.com/spacejam/sled) database, the
`paste_db/` directory. The first time a newer version starts, it imports that database automatically:

1. It copies everything into `e2epaste.redb`: pastes, pending attachment uploads and site stats.
   Attachments in `file_store/` stay where they are.
2. It renames `paste_db/` to `paste_db.sled-backup/`. Nothing in the old database is changed or deleted.
3. It logs what it imported. Check that your pastes open, then delete `paste_db.sled-backup/`.

The import happens in a temporary file that only replaces `e2epaste.redb` once it's complete, so if
it's interrupted, the next start simply runs it again. To go back to the old version, stop the server,
delete `e2epaste.redb` and rename `paste_db.sled-backup/` back to `paste_db/`. Any pastes created since
the upgrade will be lost.

The database also records its schema version, and future changes to its layout are applied
automatically at startup, the same way. A version that finds a database written by a newer version
refuses to start rather than risk damaging it.

The import is built in by default, through the `sled-import` cargo feature. A build without it
(`cargo build --no-default-features`) has no sled code, and refuses to start if it finds a `paste_db/`
that hasn't been imported.

### Build options

| Variable               | Effect                                                                                         |
| ---------------------- | ---------------------------------------------------------------------------------------------- |
| `SKIP_NPM_BUILD=1`     | Skip `npm ci` and webpack, for example when the bundles in `static/js/dist/` are already built |
| `NODE_ENV=development` | Build unminified JavaScript bundles                                                            |

## Tests

| Command            | What it runs                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `cargo test --workspace` | Rust unit tests: storage, migrations and the sled import, rate limits, tokens, the format's sizes, and e2ep's crypto |
| `npm test`         | JavaScript unit tests: paste formats v1 to v4 (old pastes made with the code that created them), v4 padding, access proofs, the text tools |
| `npm run test:e2e` | Browser tests in headless Chrome, each against its own server                                                                  |

The browser tests need a built server and `e2ep`, and their own npm package, kept apart so building the
site doesn't install it:

```sh
cargo build --workspace
npm ci --prefix tests
npm run test:e2e            # all suites
npm run test:e2e security   # suites whose name contains "security"
```

They find Chrome in the usual places, or set `CHROME_PATH`. Each suite gets a fresh server on its own port,
with an empty data directory and the settings it needs. The suites cover:

- creating and viewing pastes, attachments, burn after reading, delete links and the admin API
- the security headers and Content Security Policy, which every suite checks for violations
- access proofs and the unlock rate limit
- Markdown rendering against hostile pastes, and language detection
- old paste formats, plain-HTTP warnings, the tools, and the mobile layout
- `e2ep` against a real server: its pastes open in the browser and the browser's open with it
- `e2ep mcp`, driven as an MCP client would, including what the model isn't allowed to do

[GitHub Actions](.github/workflows/ci.yml) runs all of these on every push and pull request. It also runs
`cargo fmt`, `clippy`, `cargo audit`, `npm audit` and a Docker build, and repeats the audits weekly.
Pushing a `cli-v*` tag (matching `cli/Cargo.toml`'s version) builds `e2ep` for Linux, macOS and Windows
and publishes a release with checksums ([release-cli.yml](.github/workflows/release-cli.yml)).

## Project layout

| Path                               | What's there                                                                                                                                |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/`                             | The Rocket server: routes, settings ([`src/config.rs`](src/config.rs)), storage and the tool-page registry ([`src/tools.rs`](src/tools.rs)) |
| `cli/`                             | `e2ep`, the command-line client                                                                                                             |
| `crates/e2epaste-format/`          | The paste format's padded sizes, shared by the server and `e2ep`                                                                            |
| `js/`                              | Browser code, bundled by webpack into `static/js/dist/`: encryption, page scripts and tools                                                 |
| `templates/`                       | MiniJinja page templates                                                                                                                    |
| `static/`                          | CSS, fonts, icons and vendored libraries                                                                                                    |
| `build.rs`                         | Runs npm and webpack during `cargo build`                                                                                                   |
| `Dockerfile`, `docker-compose.yml` | The Docker image and a Compose setup for it                                                                                                 |
| `deploy/`                          | The systemd unit, its settings file and install script, and how to move a site to a new server                                            |
| `tests/`                           | JavaScript unit tests, browser tests and their runner ([`tests/run-e2e.mjs`](tests/run-e2e.mjs))                                            |
| `.github/workflows/`               | CI, and `e2ep` releases                                                                                                                     |

## Credits

e2ePaste.XYZ is built on open source projects, including Rocket, redb, Bootstrap, highlight.js, pako and
zxcvbn-ts. The full list, with licences, is on the [credits page](https://e2epaste.xyz/credits).

## License

[MIT](LICENSE) © 2024 bleach86
