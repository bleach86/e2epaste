# e2ePaste.XYZ

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
- **File attachments** up to 25 MB, alongside up to 1 MB of text.
- **Syntax highlighting** for 35 languages, live while you type.
- **Short links and QR codes** for sharing. Link previews in chat apps show a generic card, never the
  content.
- **No accounts, no tracking**, and no third-party requests: fonts and scripts are served by the site itself.
- **Browser-only tools:** a password generator and strength checker, Base64, hex and binary converters, a
  character counter and more. Like pastes, nothing you enter is sent to the server.

## How it works

When you create a paste, your browser:

1. generates a random 128-bit secret,
2. derives an AES-256 key from it with HKDF-SHA256 (if you set a password, it's stretched with
   PBKDF2-SHA256, 600,000 rounds, and mixed in),
3. compresses the text, title, file and file name, then encrypts each with AES-256-GCM using its own IV,
4. derives a separate *access proof* from the same secret (and password) with different HKDF info, and
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

The server does store some information it needs to work: the syntax highlighting choice, sizes, when the
paste was created and expires, the view count and limit, whether it has a password, and the hashes of the
access proof and the creator's delete link. Like any website, it can also see IP addresses.

Pages are served with a strict Content Security Policy: scripts only from the site itself, with no inline
script or style. Paste pages and API responses are marked `no-store`, so browsers and proxies don't keep
copies.

**Limits of the design.** Anyone with the full link can read the paste, so it's only as private as the
channel you send the link through; a password protects against that. And as with every browser-based
encrypted service, the encryption code is delivered by the site itself, so you're trusting the server to
send unmodified code. That's why the code is open source.

The encryption code is in [`js/crypto.mjs`](js/crypto.mjs). Older paste formats (v1 and v2) are still
decrypted for existing links; new pastes always use v3. Pastes created before access proofs existed open
without one, and their views are still counted by the server.

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

| Setting | Default | What it does |
|---|---|---|
| `site_url` | `http://localhost:8001` | The site's public address: `https://` plus the domain, with no path |
| `data_dir` | `.` (working directory) | Where the database (`e2epaste.redb`) and attachments (`file_store/`) are kept. Both are created if missing |
| `address` | `127.0.0.1` | Address to listen on. The default only accepts connections from the same machine, for a reverse proxy there. Use `0.0.0.0` if the proxy is on another machine |
| `port` | `8001` | Port to listen on |
| `ip_header` | `X-Real-IP` | Header the reverse proxy puts the visitor's IP in (see [Limits](#limits)) |
| `unlock_attempts_per_hour` | `30` | Failed attempts to open or delete a paste (wrong link, password or delete link) one IP can make per hour |
| `admin_token` | unset | Turns on the [admin API](#taking-a-paste-down). At least 32 characters |
| `pastes_per_minute` | `10` | Pastes one IP can create per minute |
| `pastes_per_hour` | `60` | Pastes one IP can create per hour |
| `upload_mib_per_hour` | `250` | Attachment data one IP can upload per hour, in MiB. At least 26, the largest attachment |
| `min_free_disk_mib` | `1024` | New pastes are refused when the disk holding `data_dir` has less free space than this |
| `max_attachment_storage_mib` | `0` | Cap on the total size of all stored attachments |
| `static_dir` | `static` | Front-end files, served at `/public` |
| `template_dir` | `templates` | Page templates |

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

**The reverse proxy must pass the visitor's IP.** Behind a proxy, every request comes from the proxy's
own address, so without this all visitors would share one limit. The server reads the IP from the
`X-Real-IP` header, which every [proxy example below](#https-with-a-reverse-proxy) sets. The proxy must
*overwrite* the header rather than pass on one sent by the visitor. Also make sure visitors can't reach
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

#### Running it as a service

This sets it up with systemd, with the code in `/opt/e2epaste` and the data in `/var/lib/e2epaste`.

1. Clone and build:

   ```sh
   sudo mkdir /opt/e2epaste && sudo chown "$USER" /opt/e2epaste
   git clone https://github.com/bleach86/e2epaste.git /opt/e2epaste
   cd /opt/e2epaste
   cargo build --release
   ```

2. Create `/etc/systemd/system/e2epaste.service`:

   ```ini
   [Unit]
   Description=e2ePaste
   After=network.target

   [Service]
   WorkingDirectory=/opt/e2epaste
   ExecStart=/opt/e2epaste/target/release/e2epaste
   Environment=ROCKET_SITE_URL=https://paste.example.com
   Environment=ROCKET_DATA_DIR=/var/lib/e2epaste
   # Runs as a throwaway user that can only write to /var/lib/e2epaste.
   DynamicUser=yes
   StateDirectory=e2epaste
   Restart=on-failure

   [Install]
   WantedBy=multi-user.target
   ```

3. Start it, and check the log:

   ```sh
   sudo systemctl daemon-reload
   sudo systemctl enable --now e2epaste
   journalctl -u e2epaste -f
   ```

To update: `git pull && cargo build --release && sudo systemctl restart e2epaste`.

If you already run an instance with the data in the repository directory, stop it and move the
database (`e2epaste.redb`, or `paste_db/` from older versions) and `file_store/` into the new
`data_dir`. Move them together so the database and attachments stay in step.

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

    # The largest request is a 26 MiB attachment.
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

| Path (in `data_dir`) | Contents |
|---|---|
| `e2epaste.redb` | The paste database ([redb](https://www.redb.org/)): encrypted pastes, the expiry index and site stats |
| `file_store/` | Encrypted attachments, one file per paste |

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

| Variable | Effect |
|---|---|
| `SKIP_NPM_BUILD=1` | Skip `npm ci` and webpack, for example when the bundles in `static/js/dist/` are already built |
| `NODE_ENV=development` | Build unminified JavaScript bundles |

## Project layout

| Path | What's there |
|---|---|
| `src/` | The Rocket server: routes, settings ([`src/config.rs`](src/config.rs)), storage and the tool-page registry ([`src/tools.rs`](src/tools.rs)) |
| `js/` | Browser code, bundled by webpack into `static/js/dist/`: encryption, page scripts and tools |
| `templates/` | MiniJinja page templates |
| `static/` | CSS, fonts, icons and vendored libraries |
| `build.rs` | Runs npm and webpack during `cargo build` |
| `Dockerfile`, `docker-compose.yml` | The Docker image and a Compose setup for it |

## Credits

e2ePaste.XYZ is built on open source projects, including Rocket, redb, Bootstrap, highlight.js, pako and
zxcvbn-ts. The full list, with licences, is on the [credits page](https://e2epaste.xyz/credits).

## License

[MIT](LICENSE) © 2024 bleach86
