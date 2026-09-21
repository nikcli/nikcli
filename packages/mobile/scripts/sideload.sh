#!/usr/bin/env bash
# Downloads the latest nikcli iOS build from GitHub releases, verifies it
# against the published checksums and hands it to the right installer.
#
# The .ipa in the release is deliberately unsigned: without an Apple Developer
# Program membership no certificate exists that would let a downloaded build
# install on an arbitrary device. The signature has to be produced on your own
# machine, with your own Apple ID, by Sideloadly / AltStore / SideStore.
#
# This script therefore automates everything up to that point — locating the
# build, verifying it, finding your device — and then stops. It never asks for
# an Apple ID or a password: handing credentials to a shell script is exactly
# the habit that makes sideloading dangerous, and the GUI installers already
# store them in the system keychain.
#
# Usage:
#   ./scripts/sideload.sh              # device build (.ipa)
#   ./scripts/sideload.sh --simulator  # install into a booted iOS Simulator
#   ./scripts/sideload.sh --tag v1.2.3 # a specific release instead of the latest
#   ./scripts/sideload.sh --keep-dir ~/Downloads
#
# macOS ships bash 3.2, so nothing here uses bash 4 syntax.

set -euo pipefail

REPO="nikcli/nikcli"
MODE="device"
TAG=""
KEEP_DIR=""

while [ $# -gt 0 ]; do
  case "$1" in
    --simulator) MODE="simulator"; shift ;;
    --tag) TAG="${2:-}"; [ -n "$TAG" ] || { echo "--tag needs a value" >&2; exit 2; }; shift 2 ;;
    --keep-dir) KEEP_DIR="${2:-}"; [ -n "$KEEP_DIR" ] || { echo "--keep-dir needs a value" >&2; exit 2; }; shift 2 ;;
    -h|--help) sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

die() { echo "error: $*" >&2; exit 1; }
say() { printf '\033[1m%s\033[0m\n' "$*"; }

command -v curl >/dev/null 2>&1 || die "curl is required."

if command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
elif command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d' ' -f1; }
else
  die "neither shasum nor sha256sum is available — cannot verify the download."
fi

# --- locate the release -------------------------------------------------------
# Parsed with grep/sed rather than jq or python so the script has no
# dependencies beyond curl on a stock macOS or Linux box.
if [ -n "$TAG" ]; then
  API="https://api.github.com/repos/$REPO/releases/tags/$TAG"
else
  API="https://api.github.com/repos/$REPO/releases/latest"
fi

# An empty array expanded under `set -u` aborts on bash 3.2, which is what
# macOS still ships, so the optional auth header goes through a wrapper instead.
GH_AUTH_HEADER=""
if [ -n "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ]; then
  GH_AUTH_HEADER="Authorization: Bearer ${GH_TOKEN:-$GITHUB_TOKEN}"
fi
gh_curl() {
  if [ -n "$GH_AUTH_HEADER" ]; then
    curl -H "$GH_AUTH_HEADER" "$@"
  else
    curl "$@"
  fi
}

say "Looking up ${TAG:-the latest release} of ${REPO}..."
RELEASE="$(gh_curl -fsSL -H 'Accept: application/vnd.github+json' "$API")" \
  || die "could not reach the GitHub API. If you are rate limited, set GH_TOKEN."

RELEASE_TAG="$(printf '%s' "$RELEASE" | grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
[ -n "$RELEASE_TAG" ] || die "the API response contained no tag_name."

urls() { printf '%s' "$RELEASE" | grep -o '"browser_download_url"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"\(https[^"]*\)"$/\1/'; }

if [ "$MODE" = "simulator" ]; then
  PATTERN='simulator\.app\.zip$'
  WHAT="simulator build"
else
  PATTERN='unsigned\.ipa$'
  WHAT="unsigned .ipa"
fi

ASSET_URL="$(urls | grep -E "$PATTERN" | head -1 || true)"
if [ -z "$ASSET_URL" ]; then
  echo "Release $RELEASE_TAG carries no $WHAT." >&2
  echo "Assets published on that release:" >&2
  urls | sed 's|.*/|  |' >&2
  die "nothing to install. iOS artifacts come from the mobile-ios workflow — check it ran for this tag."
fi
# mobile-ios.yml publishes checksums-ios.txt; the plain checksums.txt on the
# same release belongs to the Android build.
SUMS_URL="$(urls | grep -E '/checksums-ios\.txt$' | head -1 || true)"

# --- download and verify ------------------------------------------------------
if [ -n "$KEEP_DIR" ]; then
  mkdir -p "$KEEP_DIR"
  WORK="$KEEP_DIR"
  CLEANUP=""
else
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/nikcli-sideload.XXXXXX")"
  CLEANUP="$WORK"
fi
# shellcheck disable=SC2064
[ -z "$CLEANUP" ] || trap "rm -rf '$CLEANUP'" EXIT

ASSET_NAME="${ASSET_URL##*/}"
say "Downloading $ASSET_NAME ($RELEASE_TAG)..."
gh_curl -fL --progress-bar -o "$WORK/$ASSET_NAME" "$ASSET_URL" || die "download failed."

if [ -n "$SUMS_URL" ]; then
  gh_curl -fsSL -o "$WORK/checksums-ios.txt" "$SUMS_URL" || die "could not fetch checksums-ios.txt."
  EXPECTED="$(grep -F " $ASSET_NAME" "$WORK/checksums-ios.txt" | head -1 | cut -d' ' -f1 || true)"
  if [ -z "$EXPECTED" ]; then
    die "checksums-ios.txt has no entry for $ASSET_NAME — refusing to install an unverifiable build."
  fi
  ACTUAL="$(sha256 "$WORK/$ASSET_NAME")"
  if [ "$EXPECTED" != "$ACTUAL" ]; then
    die "checksum mismatch for $ASSET_NAME (expected $EXPECTED, got $ACTUAL)."
  fi
  echo "sha256 verified: $ACTUAL"
else
  # The release is expected to publish checksums-ios.txt; its absence means the
  # artifacts were uploaded by something other than the mobile-ios workflow.
  die "the release publishes no checksums-ios.txt — refusing to install an unverified build."
fi

# --- simulator: fully automatic ----------------------------------------------
if [ "$MODE" = "simulator" ]; then
  [ "$(uname -s)" = "Darwin" ] || die "the simulator build only runs on macOS."
  command -v xcrun >/dev/null 2>&1 || die "xcrun not found — install Xcode."
  command -v unzip >/dev/null 2>&1 || die "unzip is required."

  if ! xcrun simctl list devices booted | grep -q "(Booted)"; then
    die "no booted simulator. Start one with: open -a Simulator"
  fi
  rm -rf "$WORK/extracted"
  mkdir -p "$WORK/extracted"
  unzip -q "$WORK/$ASSET_NAME" -d "$WORK/extracted"
  APP="$WORK/extracted/nikcli.app"
  [ -d "$APP" ] || die "the archive did not contain nikcli.app."

  say "Installing into the booted simulator..."
  xcrun simctl install booted "$APP"
  xcrun simctl launch booted ai.nikcli.mobile >/dev/null
  say "Done — nikcli is running in the simulator."
  exit 0
fi

# --- device: verify it really is unsigned, then hand off ----------------------
if command -v unzip >/dev/null 2>&1 && command -v codesign >/dev/null 2>&1; then
  rm -rf "$WORK/inspect"
  mkdir -p "$WORK/inspect"
  unzip -q "$WORK/$ASSET_NAME" -d "$WORK/inspect" 'Payload/nikcli.app/*' 2>/dev/null || true
  if [ -d "$WORK/inspect/Payload/nikcli.app" ] && codesign -dv "$WORK/inspect/Payload/nikcli.app" >/dev/null 2>&1; then
    die "this .ipa is already signed — it is not the build this script expects."
  fi
fi

UDID=""
if command -v idevice_id >/dev/null 2>&1; then
  UDID="$(idevice_id -l 2>/dev/null | head -1 || true)"
fi

IPA="$WORK/$ASSET_NAME"
if [ -z "$KEEP_DIR" ]; then
  # The handoff below is manual, so the file has to outlive this script.
  DEST="${HOME}/Downloads"
  mkdir -p "$DEST"
  cp "$IPA" "$DEST/$ASSET_NAME"
  IPA="$DEST/$ASSET_NAME"
fi

echo
say "Ready: $IPA"
echo
echo "This build is unsigned. Pick the path that matches your device:"
echo
echo "  1. TrollStore — permanent, no Apple ID, no 7-day expiry."
echo "     Only if your iOS version is TrollStore-compatible. Send the .ipa to the"
echo "     phone (AirDrop or a share sheet) and open it with TrollStore."
echo
echo "  2. SideStore — free Apple ID, refreshes itself on the phone afterwards."
echo "     Best option if TrollStore does not apply: the first setup needs a"
echo "     computer once, then the 7-day renewal happens on-device. https://sidestore.io"
echo
echo "  3. Sideloadly / AltStore — free Apple ID, needs this computer plugged in"
echo "     every 7 days to refresh. https://sideloadly.io"
echo
echo "All three re-sign the app with YOUR Apple ID. A free Apple ID allows three"
echo "sideloaded apps at a time and the signature lasts 7 days."
echo
if [ -n "$UDID" ]; then
  echo "Connected device: $UDID"
fi

if [ "$(uname -s)" = "Darwin" ]; then
  if [ -d "/Applications/Sideloadly.app" ]; then
    say "Opening Sideloadly with the build preloaded..."
    open -a Sideloadly "$IPA"
  elif [ -d "/Applications/AltServer.app" ]; then
    say "Revealing the build — drop it into AltServer."
    open -R "$IPA"
  else
    open -R "$IPA"
  fi
fi
