#!/usr/bin/env bash
# Installs or updates e2epaste as a systemd service, from a built checkout:
#
#   cargo build --release --locked -p e2epaste   # as yourself
#   sudo deploy/install.sh                        # then this, as root
#
# The first run creates the e2epaste user, /etc/e2epaste/e2epaste.env (edit
# it, then start the service) and the service. Later runs install the new
# build and restart the service, keeping the previous binary as
# /opt/e2epaste/e2epaste.previous. See README.md ("As a systemd service").
#
# Options:
#   --data-from DIR   on the first run, move an existing data directory's
#                     database and attachments (paste_db/, e2epaste.redb,
#                     file_store/) into /var/lib/e2epaste
set -euo pipefail

PREFIX=/opt/e2epaste
DATA=/var/lib/e2epaste
CONFIG_DIR=/etc/e2epaste
UNIT=/etc/systemd/system/e2epaste.service
SERVICE_USER=e2epaste

repo="$(cd "$(dirname "$0")/.." && pwd)"
data_from=""
while [ $# -gt 0 ]; do
    case "$1" in
        --data-from) data_from="${2:?--data-from needs a directory}"; shift 2 ;;
        *) echo "Unknown option: $1" >&2; exit 2 ;;
    esac
done

if [ "$(id -u)" -ne 0 ]; then
    echo "Run this as root (sudo $0)." >&2
    exit 1
fi
binary="$repo/target/release/e2epaste"
if [ ! -x "$binary" ] || [ ! -d "$repo/static/js/dist" ]; then
    echo "No release build in $repo. Build it first, as yourself:" >&2
    echo "  cargo build --release --locked -p e2epaste" >&2
    exit 1
fi

first_run=no
[ -f "$UNIT" ] || first_run=yes

# The service's own user, with no login and no home.
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    useradd --system --user-group --no-create-home --home-dir "$DATA" \
        --shell /usr/sbin/nologin "$SERVICE_USER"
    echo "Created the $SERVICE_USER user."
fi

# The program and its files, read-only to the service. The new binary is
# put in place with a rename, so a running one is never half-overwritten.
install -d -m 755 "$PREFIX"
if [ -f "$PREFIX/e2epaste" ]; then
    cp -p "$PREFIX/e2epaste" "$PREFIX/e2epaste.previous"
fi
install -m 755 "$binary" "$PREFIX/e2epaste.new"
mv -f "$PREFIX/e2epaste.new" "$PREFIX/e2epaste"
install -m 644 "$repo/Rocket.toml" "$PREFIX/Rocket.toml"
for dir in templates static; do
    rm -rf "$PREFIX/$dir.new"
    cp -r "$repo/$dir" "$PREFIX/$dir.new"
    chmod -R u=rwX,go=rX "$PREFIX/$dir.new"
    rm -rf "$PREFIX/$dir.old"
    if [ -d "$PREFIX/$dir" ]; then mv "$PREFIX/$dir" "$PREFIX/$dir.old"; fi
    mv "$PREFIX/$dir.new" "$PREFIX/$dir"
    rm -rf "$PREFIX/$dir.old"
done

# Settings: created once, never overwritten.
install -d -m 750 -o root -g "$SERVICE_USER" "$CONFIG_DIR"
if [ ! -f "$CONFIG_DIR/e2epaste.env" ]; then
    install -m 640 -o root -g "$SERVICE_USER" "$repo/deploy/e2epaste.env.example" "$CONFIG_DIR/e2epaste.env"
    echo "Created $CONFIG_DIR/e2epaste.env: set ROCKET_SITE_URL (and the rest) in it."
fi

# Data: an existing setup's database and attachments, moved on the first run.
install -d -m 750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA"
if [ -n "$data_from" ]; then
    for item in paste_db e2epaste.redb file_store; do
        if [ -e "$DATA/$item" ]; then
            echo "$DATA/$item already exists; not moving $data_from/$item." >&2
        elif [ -e "$data_from/$item" ]; then
            mv "$data_from/$item" "$DATA/$item"
            echo "Moved $data_from/$item to $DATA/."
        fi
    done
    chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA"
fi

install -m 644 "$repo/deploy/e2epaste.service" "$UNIT"
systemctl daemon-reload

if [ "$first_run" = yes ]; then
    systemctl enable e2epaste
    echo
    echo "Installed. Next:"
    echo "  1. Edit $CONFIG_DIR/e2epaste.env (at least ROCKET_SITE_URL)."
    echo "  2. sudo systemctl start e2epaste"
    echo "  3. journalctl -u e2epaste -f    to see it start"
else
    systemctl restart e2epaste
    echo "Updated and restarted. To go back to the previous version:"
    echo "  sudo mv $PREFIX/e2epaste.previous $PREFIX/e2epaste && sudo systemctl restart e2epaste"
    systemctl --no-pager --lines=5 status e2epaste || true
fi
