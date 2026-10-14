#!/usr/bin/env bash
#
# Put the newest Burnhouse on this Mac and open it.
#
# Run on the Mac:   bash install-burnhouse.sh
#
# It fetches the latest release, replaces whatever is in /Applications, and
# launches it. Nothing is compiled here and nothing else is installed — the .dmg
# already contains every tool the app needs, built for macOS 12.
#
# Why a script rather than a download by hand: the app has to be replaced
# cleanly (a half-copied .app launches and then misbehaves in ways that look like
# new bugs), and macOS quarantines anything downloaded, so the first launch needs
# the right click-through. This does both.

set -euo pipefail

trap 'status=$?; if [ "${status}" -ne 0 ]; then
        echo "" >&2
        echo "ERROR: stopped at line ${LINENO} (exit ${status})" >&2
      fi' ERR

REPO="collin12121212/DVDBurner"
APP_NAME="Burnhouse"
DEST="/Applications/${APP_NAME}.app"

echo "==> Finding the newest release"
# The API gives the tag; the download URL is built from it so no HTML is parsed.
TAG="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
       | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)"

if [ -z "${TAG}" ]; then
  echo "Could not work out which release is newest." >&2
  exit 1
fi

VERSION="${TAG#v}"
URL="https://github.com/${REPO}/releases/download/${TAG}/${APP_NAME}-${VERSION}.dmg"
echo "    ${TAG}  ->  ${APP_NAME}-${VERSION}.dmg"

WORK="$(mktemp -d)"
DMG="${WORK}/${APP_NAME}.dmg"
MOUNT=""

cleanup() {
  if [ -n "${MOUNT}" ] && [ -d "${MOUNT}" ]; then
    hdiutil detach "${MOUNT}" -quiet -force >/dev/null 2>&1 || true
  fi
  rm -rf "${WORK}"
}
trap cleanup EXIT

echo "==> Downloading"
curl -fL --retry 3 --retry-delay 2 --progress-bar -o "${DMG}" "${URL}"

# A .dmg is a compressed image; the magic bytes catch a truncated download or an
# error page saved under the right name, either of which would fail confusingly
# later.
if [ "$(head -c 2 "${DMG}" | xxd -p)" != "78da" ] && [ "$(head -c 4 "${DMG}" | xxd -p)" != "6b6f6c79" ]; then
  echo "The downloaded file is not a disk image." >&2
  ls -la "${DMG}" >&2
  exit 1
fi
echo "    $(du -h "${DMG}" | cut -f1)"

echo "==> Mounting"
# No -quiet here: it suppresses the mount point too, which is the one thing this
# needs. The trailing `|| true` keeps a failed grep from aborting the script
# before the check below can explain what happened.
MOUNT="$(hdiutil attach "${DMG}" -nobrowse 2>/dev/null | grep -o '/Volumes/.*' | head -1 || true)"
if [ -z "${MOUNT}" ] || [ ! -d "${MOUNT}/${APP_NAME}.app" ]; then
  echo "The image mounted but does not contain ${APP_NAME}.app." >&2
  ls -la "${MOUNT}" >&2 || true
  exit 1
fi

# Quit a running copy first, or the replacement leaves the old process alive and
# the new one refusing to start.
if pgrep -x "${APP_NAME}" >/dev/null 2>&1; then
  echo "==> Closing the running copy"
  osascript -e "quit app \"${APP_NAME}\"" >/dev/null 2>&1 || pkill -x "${APP_NAME}" || true
  sleep 2
fi

echo "==> Installing to ${DEST}"
# Copied to a staging path and moved into place, so an interrupted copy cannot
# leave a half-written app in /Applications.
STAGE="/Applications/.${APP_NAME}.new"
rm -rf "${STAGE}"
cp -R "${MOUNT}/${APP_NAME}.app" "${STAGE}"
rm -rf "${DEST}"
mv "${STAGE}" "${DEST}"

echo "==> Removing the download quarantine"
# Without this macOS refuses the first launch outright. The app is not notarised
# (that needs a paid Apple Developer account), so the flag is cleared here rather
# than leaving somebody to find the right-click trick.
xattr -dr com.apple.quarantine "${DEST}" 2>/dev/null || true

echo "==> Opening"
open "${DEST}"

echo ""
echo "Done. ${APP_NAME} ${VERSION} is in Applications and should be starting now."
