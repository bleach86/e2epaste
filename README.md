# e2ePaste.XYZ

An end-to-end encrypted pastebin for text and files. Everything is encrypted in your browser before it's
uploaded, and the key never reaches the server, so the server only ever stores data it can't read.

**Live at [e2epaste.xyz](https://e2epaste.xyz)**

## Features

- **End-to-end encryption.** Pastes, titles, file attachments and file names are encrypted with AES-256-GCM
  in the browser.
- **Optional password.** The paste can't be decrypted without it, even by someone who has the link.
- **Expiry and view limits.** Pastes expire after 10 minutes to 1 year. Set a view limit of 1 for
  "burn after reading".
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
4. uploads only the encrypted data.

The secret goes in the link after the `#`, for example `https://e2epaste.xyz/s/Ab3dE5gH#<secret>`.
Browsers never send the part after `#` to the server, so the server never has the key. When someone opens
the link, their browser reads the secret and decrypts the paste locally.

The server does store some information it needs to work: the syntax highlighting choice, sizes, when the
paste was created and expires, the view count and limit, and whether it has a password. Like any website,
it can also see IP addresses.

**Limits of the design.** Anyone with the full link can read the paste, so it's only as private as the
channel you send the link through; a password protects against that. And as with every browser-based
encrypted service, the encryption code is delivered by the site itself, so you're trusting the server to
send unmodified code. That's why the code is open source.

The encryption code is in [`js/crypto.mjs`](js/crypto.mjs). Older paste formats (v1 and v2) are still
decrypted for existing links; new pastes always use v3.

## Self-hosting

You can run your own instance with Docker or as a native binary. Either way:

- **It needs HTTPS.** Browsers only allow the Web Crypto API on HTTPS pages (and on `localhost`), so
  encryption won't work over plain HTTP. Run the server behind a reverse proxy that handles TLS, such as
  Caddy or nginx ([examples below](#https-with-a-reverse-proxy)).
- **Set `site_url` to your address**, for example `https://paste.example.com`. It's used for canonical
  links, the sitemap, robots.txt and link previews. Paste links always use the address the page was
  opened at, so they work even before you set it.

### Configuration

Settings are read from [`Rocket.toml`](Rocket.toml). Any of them can be overridden with an environment
variable named `ROCKET_` plus the setting in capitals, such as `ROCKET_SITE_URL`.

| Setting | Default | What it does |
|---|---|---|
| `site_url` | `http://localhost:8001` | The site's public address: `https://` plus the domain, with no path |
| `data_dir` | `.` (working directory) | Where the database (`paste_db/`) and attachments (`file_store/`) are kept. Both are created if missing |
| `address` | `0.0.0.0` | Address to listen on. Use `127.0.0.1` when the reverse proxy is on the same machine |
| `port` | `8001` | Port to listen on |
| `static_dir` | `static` | Front-end files, served at `/public` |
| `template_dir` | `templates` | Page templates |

`static_dir` and `template_dir` are relative to the working directory, so run the server from the
repository directory or set them to absolute paths. The server prints the site URL and directories it's
using when it starts, and warns if `site_url` is still `localhost` in a release build.

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

Open <http://localhost:8001>. Pastes are stored in `paste_db/` and `file_store/` in the repository
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
   Environment=ROCKET_ADDRESS=127.0.0.1
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

If you already run an instance with the data in the repository directory, stop it and move `paste_db/`
and `file_store/` into the new `data_dir`. Copy both directories so the database and attachments stay
in step.

### HTTPS with a reverse proxy

Point the proxy at the port the server listens on. With [Caddy](https://caddyserver.com/), which gets a
certificate automatically, the whole `Caddyfile` is:

```
paste.example.com {
    reverse_proxy 127.0.0.1:8001
}
```

With nginx, raise the request size limit. The default of 1 MB is too small for large pastes and
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

### Data

| Path (in `data_dir`) | Contents |
|---|---|
| `paste_db/` | The paste database ([sled](https://github.com/spacejam/sled)): encrypted pastes and site stats |
| `file_store/` | Encrypted attachments, one file per paste |

Expired pastes are deleted every 15 minutes. Back up both directories together, with the server stopped.

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

e2ePaste.XYZ is built on open source projects, including Rocket, sled, Bootstrap, highlight.js, pako and
zxcvbn-ts. The full list, with licences, is on the [credits page](https://e2epaste.xyz/credits).

## License

[MIT](LICENSE) © 2024 bleach86
