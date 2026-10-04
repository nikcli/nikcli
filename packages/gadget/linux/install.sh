#!/usr/bin/env bash
# Install the nikcli gadget as a systemd service.
#
#   bash install.sh --from <dir-with-gadget.ts> --user <account> [--server <url> --code <code>] [--yes]
#
# State lives in /var/lib/nikcli-gadget (NIKCLI_GADGET_STATE); reinstalling keeps the pairing.
set -euo pipefail

FROM="."
USER_NAME=""
SERVER=""
CODE=""
YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --from) FROM="$2"; shift 2 ;;
    --user) USER_NAME="$2"; shift 2 ;;
    --server) SERVER="$2"; shift 2 ;;
    --code) CODE="$2"; shift 2 ;;
    --yes) YES=1; shift ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done

if [ -z "$USER_NAME" ]; then
  USER_NAME="${SUDO_USER:-$(id -un)}"
fi
if [ "$(id -u)" -ne 0 ]; then
  echo "run with sudo: the unit and /var/lib/nikcli-gadget need root once" >&2
  exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is required: the SDK ships TypeScript, which Node will not run from node_modules (https://bun.sh)" >&2
  exit 1
fi
RUNTIME="$(command -v bun)"

FROM="$(cd "$FROM" && pwd)"
GADGET_FILE=""
for candidate in gadget.ts gadget.js gadget.mjs; do
  if [ -f "$FROM/$candidate" ]; then GADGET_FILE="$FROM/$candidate"; break; fi
done
CLI="$FROM/node_modules/@nikcli-ai/gadget/linux/src/cli.ts"
if [ ! -f "$CLI" ]; then
  echo "@nikcli-ai/gadget is not installed in $FROM (run: bun add @nikcli-ai/gadget)" >&2
  exit 1
fi

STATE=/var/lib/nikcli-gadget
echo "nikcli gadget"
echo "  runtime : $RUNTIME"
echo "  gadget  : ${GADGET_FILE:-<built-ins only>}"
echo "  user    : $USER_NAME"
echo "  state   : $STATE"
if [ "$YES" -ne 1 ]; then
  read -r -p "install? [y/N] " answer
  case "$answer" in y|Y|yes) ;; *) exit 0 ;; esac
fi

install -d -m 0700 -o "$USER_NAME" -g "$(id -gn "$USER_NAME")" "$STATE"

if [ -n "$SERVER" ] && [ -n "$CODE" ]; then
  sudo -u "$USER_NAME" env NIKCLI_GADGET_STATE="$STATE" $RUNTIME "$CLI" pair --server "$SERVER" --code "$CODE" ${GADGET_FILE:+"$GADGET_FILE"}
elif [ ! -f "$STATE/pairing.json" ]; then
  echo "not paired yet: run 'sudo -u $USER_NAME NIKCLI_GADGET_STATE=$STATE $RUNTIME $CLI pair --server <url> --code <code>'"
fi

cat > /etc/systemd/system/nikcli-gadget.service <<UNIT
[Unit]
Description=nikcli gadget
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER_NAME
WorkingDirectory=$FROM
Environment=NIKCLI_GADGET_STATE=$STATE
ExecStart=$RUNTIME $CLI run ${GADGET_FILE:-}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now nikcli-gadget.service
echo "installed; follow it with: journalctl -u nikcli-gadget -f"
