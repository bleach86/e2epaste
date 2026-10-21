# Moving a site to a new server

The steps for moving a running e2ePaste site, such as one started by hand from a checkout, to a new
Debian 13 server running it as a systemd service, behind Apache. They were rehearsed in full on a
Debian 13 VM: the build, the install, importing an old (sled) database, Apache, an update, going back,
and a reboot.

The old server keeps running until the new one is ready, and stays as the fallback for a while after,
so going back is a DNS change.

## 1. A day before

Lower the DNS TTL of the site's name to a few minutes, so the switch (and a switch back) takes effect
quickly.

## 2. Set up the new server

Everything here can be done while the old server is still live.

```sh
# Packages: build tools, Node for the browser bundles, Apache
sudo apt update
sudo apt install -y build-essential pkg-config git curl nodejs npm apache2 certbot python3-certbot-apache

# Rust, as your own user (not root)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
. "$HOME/.cargo/env"

# Build, as yourself
git clone https://github.com/bleach86/e2epaste.git && cd e2epaste
cargo build --release --locked -p e2epaste

# Install: the e2epaste user, /opt/e2epaste, /etc/e2epaste/e2epaste.env and the service (not
# started yet)
sudo deploy/install.sh
```

Settings go in `/etc/e2epaste/e2epaste.env`:

```sh
ROCKET_SITE_URL=https://e2epaste.xyz
ROCKET_SITE_NAME=e2ePaste.XYZ
ROCKET_ADMIN_TOKEN=<a new one: openssl rand -hex 32>
```

Apache: enable the modules, and put the site in `/etc/apache2/sites-available/e2epaste.conf` (the
[example in the main README](../README.md#https-with-a-reverse-proxy), with the certificate paths for
your domain). The `RequestHeader set X-Real-IP` line matters: without it, every visitor would share
one rate limit.

```sh
sudo a2enmod ssl proxy proxy_http headers
sudo a2ensite e2epaste && sudo a2dissite 000-default
sudo apache2ctl configtest
```

For the certificate, either copy `/etc/letsencrypt/` from the old server (HTTPS then works from the
first minute after the switch), or get a new one with `sudo certbot --apache -d e2epaste.xyz` once DNS
points at the new server.

## 3. Switch over

Downtime is the time it takes to copy the data.

1. On the old server, stop e2ePaste, so no new pastes arrive.
2. Copy its data directory's database and attachments to the new server. That's `paste_db/` (from
   releases before redb) or `e2epaste.redb`, and `file_store/`:

   ```sh
   rsync -a old-server:/path/to/e2epaste/paste_db old-server:/path/to/e2epaste/file_store ~/olddata/
   ```

3. On the new server, move it into place and start the service:

   ```sh
   sudo deploy/install.sh --data-from ~/olddata
   sudo systemctl start e2epaste
   journalctl -u e2epaste -o cat | head
   ```

   The first start imports `paste_db/` into `e2epaste.redb` and says how many pastes it imported. The
   old database is kept as `/var/lib/e2epaste/paste_db.sled-backup`.
4. Check it before switching DNS. From your own computer, point the name at the new server for
   yourself (an `/etc/hosts` line), then open the site, create and open a paste, and open an old link.
5. Point DNS at the new server.

## 4. Check it's working

```sh
curl -sI https://e2epaste.xyz | grep -i -e strict-transport -e content-security   # headers and HSTS
e2ep limits --server https://e2epaste.xyz                                          # "Paste format: 4"
systemctl status e2epaste apache2
systemd-analyze security e2epaste | tail -1                                        # about 1.2, "OK"
```

Rate limits are per visitor, so check Apache passes visitors' addresses: creating 11 pastes in a minute
from one computer should get the 11th refused, even if each request sends its own made-up `X-Real-IP`.

## Going back

- **Before the old server is gone:** point DNS back at it and start e2ePaste there again. Pastes made
  on the new server in the meantime stay behind on it.
- **To the previous build, on the new server:**
  `sudo mv /opt/e2epaste/e2epaste.previous /opt/e2epaste/e2epaste && sudo systemctl restart e2epaste`

Keep the old server, with e2ePaste stopped, for a week or two before cancelling it. Once everything
looks right, `/var/lib/e2epaste/paste_db.sled-backup` can be deleted.

## Updating later

```sh
cd e2epaste && git pull && cargo build --release --locked -p e2epaste && sudo deploy/install.sh
```
