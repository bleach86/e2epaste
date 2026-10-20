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

## Running it yourself

### Requirements

- A recent stable [Rust](https://www.rust-lang.org/tools/install) toolchain
- [Node.js](https://nodejs.org/) with npm

`cargo build` runs `npm ci` and webpack for you (see [`build.rs`](build.rs)), so there's no separate
front-end build step.

### Build and run

```sh
git clone https://github.com/bleach86/e2epaste.git
cd e2epaste
cargo run --release
```

The server listens on port 8001 (all interfaces, `0.0.0.0`). Open <http://localhost:8001>.

Run it from the repository directory: it reads `templates/` and stores its data relative to the working
directory, and serves `static/` from the directory it was built in.

### Before you deploy

- **Serve it over HTTPS.** Browsers only allow the Web Crypto API on HTTPS pages (and `localhost`), so
  encryption won't work over plain HTTP. Put the server behind a reverse proxy such as Caddy or nginx that
  handles TLS.
- **Set your own address.** Links, the sitemap and link previews use the `HOST` constant at the top of
  [`src/main.rs`](src/main.rs) (`https://e2epaste.xyz`). Change it to your domain and rebuild.
- **Ports and limits** are in [`Rocket.toml`](Rocket.toml), or override them with environment variables
  such as `ROCKET_PORT=9000`.

### Data

| Path | Contents |
|---|---|
| `paste_db/` | The paste database ([sled](https://github.com/spacejam/sled)): encrypted pastes and site stats |
| `file_store/` | Encrypted attachments, one file per paste |

Expired pastes are deleted every 15 minutes. Back up both directories together.

### Build options

| Variable | Effect |
|---|---|
| `SKIP_NPM_BUILD=1` | Skip `npm ci` and webpack, for example when the bundles in `static/js/dist/` are already built |
| `NODE_ENV=development` | Build unminified JavaScript bundles |

## Project layout

| Path | What's there |
|---|---|
| `src/` | The Rocket server: routes, storage and the tool-page registry ([`src/tools.rs`](src/tools.rs)) |
| `js/` | Browser code, bundled by webpack into `static/js/dist/`: encryption, page scripts and tools |
| `templates/` | MiniJinja page templates |
| `static/` | CSS, fonts, icons and vendored libraries |
| `build.rs` | Runs npm and webpack during `cargo build` |

## Credits

e2ePaste.XYZ is built on open source projects, including Rocket, sled, Bootstrap, highlight.js, pako and
zxcvbn-ts. The full list, with licences, is on the [credits page](https://e2epaste.xyz/credits).

## License

[MIT](LICENSE) © 2024 bleach86
