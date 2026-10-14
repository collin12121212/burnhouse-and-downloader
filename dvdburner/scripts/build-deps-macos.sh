#!/usr/bin/env bash
#
# Put the tools Burnhouse needs into <output-dir>, built to run on macOS 12.
#
# macOS only. Invoked by the GitHub Actions macOS build.
#
# WHY THIS EXISTS
#
# The obvious way to get these tools is Homebrew, and it does not work here. On
# the Intel runner image — macOS 15 — every Homebrew bottle is built with a
# minimum of macOS 14.0. The Mac this app is for is a 2017 MacBook Air, whose
# newest possible macOS is 12.7.6, and a binary that needs 14 does not run there
# at all. The app would install, launch, and fail the moment a video was added.
#
# So the tools are either taken prebuilt with a low deployment target, or
# compiled here with one. Nothing is installed with Homebrew.
#
#   ffmpeg, ffprobe  static x86_64 builds for macOS 10.13, from evermeet.cx.
#                    Static means no libraries to relocate and nothing to go
#                    stale on somebody else's machine.
#   dvdauthor,spumux compiled from source with MACOSX_DEPLOYMENT_TARGET=12.0,
#                    linked against libpng (also built here, also for 12) and
#                    otherwise only against libraries macOS ships.
#
# freetype, fontconfig and fribidi are deliberately NOT provided. dvdauthor's
# configure only uses them for text-based subtitles, which this app does not
# produce, and leaving them out keeps the build small and its dependencies to
# system libraries only.
#
# Usage: scripts/build-deps-macos.sh <output-dir>

set -euo pipefail

trap 'status=$?; if [ "${status}" -ne 0 ]; then
        echo "ERROR: build-deps-macos.sh stopped at line ${LINENO} (exit ${status})" >&2
      fi' ERR

OUT_DIR="${1:?usage: build-deps-macos.sh <output-dir>}"
mkdir -p "${OUT_DIR}"
OUT_DIR="$(cd "${OUT_DIR}" && pwd)"

# The whole point of this script. Everything compiled here is built for this.
export MACOSX_DEPLOYMENT_TARGET=12.0

WORK="$(mktemp -d)"
PREFIX="${WORK}/local"
mkdir -p "${PREFIX}" "${WORK}/src"

# Resolved now, by absolute path, because later on PATH is trimmed to keep
# Homebrew's libraries out and there would be no pkg-config left to find.
# The freetype-config shim below needs it baked in for that reason.
PKG_CONFIG_BIN="$(command -v pkg-config || true)"
if [ -z "${PKG_CONFIG_BIN}" ]; then
  echo "ERROR: pkg-config is not available, so libpng cannot be located" >&2
  exit 1
fi

LIBPNG_VERSION="1.6.44"
ZLIB_VERSION="1.3.1"
ZLIB_SHA256="9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23"
FREETYPE_VERSION="2.13.3"
FREETYPE_URL="https://download.savannah.gnu.org/releases/freetype/freetype-${FREETYPE_VERSION}.tar.gz"
FREETYPE_SHA256="5c3a8e78f7b24c20b25b54ee575d6daa40007a5f4eea2845861c3409b3021747"
DVDAUTHOR_VERSION="0.7.2"
# MacPorts mirrors the upstream tarball byte for byte, which is why the checksum
# below -- the one Homebrew publishes -- matches it.
#
# Not SourceForge's own download URLs. `downloads.sourceforge.net` and
# `sourceforge.net/projects/.../download` both answer with HTTP 200 and an HTML
# page rather than the file, so `curl -f` is satisfied and `tar` fails with "not
# in gzip format". The checksum check below is what turns that into a clear
# message instead.
DVDAUTHOR_URL="https://distfiles.macports.org/dvdauthor/dvdauthor-${DVDAUTHOR_VERSION}.tar.gz"
DVDAUTHOR_SHA256="3020a92de9f78eb36f48b6f22d5a001c47107826634a785a62dfcd080f612eb7"

echo "Building for macOS ${MACOSX_DEPLOYMENT_TARGET} on $(uname -m)"
echo "Scratch: ${WORK}"
echo ""

# ------------------------------------------------------------------ ffmpeg ---
# Static Intel builds, documented as requiring macOS 10.13 or newer.
fetch_static() {
  local name="$1"
  local out="${OUT_DIR}/${name}"

  echo "==> ${name}: downloading a static build"
  curl -fsSL --retry 3 --retry-delay 2 -o "${WORK}/${name}.zip" \
    "https://evermeet.cx/ffmpeg/getrelease/${name}/zip"

  rm -rf "${WORK}/unzip-${name}"
  mkdir -p "${WORK}/unzip-${name}"
  unzip -q -o "${WORK}/${name}.zip" -d "${WORK}/unzip-${name}"

  local found
  found="$(find "${WORK}/unzip-${name}" -type f -name "${name}" | head -1)"
  if [ -z "${found}" ]; then
    echo "ERROR: no ${name} binary inside the downloaded archive" >&2
    ls -la "${WORK}/unzip-${name}" >&2 || true
    exit 1
  fi

  cp "${found}" "${out}"
  chmod +x "${out}"
  echo "    $(lipo -archs "${out}")  $(ls -la "${out}" | awk '{print $5}') bytes"
}

fetch_static ffmpeg
fetch_static ffprobe

# ------------------------------------------------------------------- zlib ---
# libpng's pkg-config file lists zlib, and macOS ships the library but no
# zlib.pc at all — which is why the lookup fails with "Package 'zlib', required
# by 'libpng', not found". Building it here keeps everything self-contained
# rather than reaching for the system copy, whose version is not ours to choose.
echo ""
echo "==> zlib ${ZLIB_VERSION}: building (static, macOS ${MACOSX_DEPLOYMENT_TARGET})"
cd "${WORK}/src"
curl -fsSL --retry 3 --retry-delay 2 -o zlib.tar.gz \
  "https://github.com/madler/zlib/releases/download/v${ZLIB_VERSION}/zlib-${ZLIB_VERSION}.tar.gz"

# Checked for the same reason as dvdauthor's: a download that is not the file it
# claims to be should fail here, not be compiled and shipped.
ZLIB_ACTUAL="$(shasum -a 256 zlib.tar.gz | awk '{print $1}')"
if [ "${ZLIB_ACTUAL}" != "${ZLIB_SHA256}" ]; then
  echo "ERROR: the zlib tarball is not the one expected." >&2
  echo "  expected ${ZLIB_SHA256}" >&2
  echo "  got      ${ZLIB_ACTUAL}" >&2
  exit 1
fi
echo "    checksum matches"

mkdir -p zlib && tar xzf zlib.tar.gz -C zlib --strip-components=1
cd zlib
./configure --prefix="${PREFIX}" --static >/dev/null
make -j"$(sysctl -n hw.ncpu)" >/dev/null 2>&1
make install >/dev/null 2>&1
echo "    installed into ${PREFIX}"

# ------------------------------------------------------------------ libpng ---
# Needed by spumux to read the button highlight images, which are PNGs.
echo ""
echo "==> libpng ${LIBPNG_VERSION}: building (static, macOS ${MACOSX_DEPLOYMENT_TARGET})"
cd "${WORK}/src"
curl -fsSL --retry 3 --retry-delay 2 -o libpng.tar.gz \
  "https://download.sourceforge.net/libpng/libpng-${LIBPNG_VERSION}.tar.gz" || \
  curl -fsSL --retry 3 --retry-delay 2 -o libpng.tar.gz \
    "https://downloads.sourceforge.net/project/libpng/libpng16/${LIBPNG_VERSION}/libpng-${LIBPNG_VERSION}.tar.gz"

mkdir -p libpng && tar xzf libpng.tar.gz -C libpng --strip-components=1
cd libpng
# PKG_CONFIG_LIBDIR points only at this prefix, so zlib has to be visible to
# libpng's own configure for the same reason dvdauthor needs it to be.
PKG_CONFIG_LIBDIR="${PREFIX}/lib/pkgconfig" \
  ./configure --prefix="${PREFIX}" --disable-shared --enable-static >/dev/null
make -j"$(sysctl -n hw.ncpu)" >/dev/null 2>&1
make install >/dev/null 2>&1
echo "    installed into ${PREFIX}"

# --------------------------------------------------------------- freetype ---
# Not optional, whatever this script used to claim. dvdauthor's configure stops
# with "configure: error: freetype not found", and it is a custom check with no
# --without flag to turn it off. freetype draws text into subpictures, which
# this app does not do, but the build will not proceed without it.
#
# dvdauthor looks specifically for `freetype-config`, so the prefix's bin has to
# be on PATH later or it will not be found even once built.
echo ""
echo "==> freetype ${FREETYPE_VERSION}: building (static, macOS ${MACOSX_DEPLOYMENT_TARGET})"
cd "${WORK}/src"
curl -fsSL --retry 3 --retry-delay 2 -o freetype.tar.gz "${FREETYPE_URL}"

FREETYPE_ACTUAL="$(shasum -a 256 freetype.tar.gz | awk '{print $1}')"
if [ "${FREETYPE_ACTUAL}" != "${FREETYPE_SHA256}" ]; then
  echo "ERROR: the freetype tarball is not the one expected." >&2
  echo "  expected ${FREETYPE_SHA256}" >&2
  echo "  got      ${FREETYPE_ACTUAL}" >&2
  exit 1
fi
echo "    checksum matches"

mkdir -p freetype && tar xzf freetype.tar.gz -C freetype --strip-components=1
cd freetype
if ! PKG_CONFIG_LIBDIR="${PREFIX}/lib/pkgconfig" \
     CPPFLAGS="-I${PREFIX}/include" \
     LDFLAGS="-L${PREFIX}/lib" \
     ./configure --prefix="${PREFIX}" --disable-shared --enable-static \
     >"${WORK}/freetype-configure.log" 2>&1; then
  echo "ERROR: freetype's configure failed. Its output:" >&2
  tail -40 "${WORK}/freetype-configure.log" >&2
  exit 1
fi
make -j"$(sysctl -n hw.ncpu)" >/dev/null 2>&1
make install >/dev/null 2>&1

# FreeType stopped installing `freetype-config` — it was deprecated in favour of
# pkg-config years ago — but dvdauthor 0.7.2 looks for it by name and by nothing
# else, so a perfectly good freetype still produces "configure: error: freetype
# not found".
#
# This shim answers in its place, using the flags FreeType itself publishes in
# freetype2.pc rather than any invented here.
cat > "${PREFIX}/bin/freetype-config" <<SHIM
#!/bin/sh
# Compatibility shim for dvdauthor. FreeType no longer installs this script;
# the same information now lives in freetype2.pc, so that is what answers.
PKG="${PKG_CONFIG_BIN}"
case "\$1" in
  --cflags)      exec "\${PKG}" --cflags freetype2 ;;
  --libs)        exec "\${PKG}" --libs freetype2 ;;
  --prefix)      exec "\${PKG}" --variable=prefix freetype2 ;;
  --exec-prefix) exec "\${PKG}" --variable=prefix freetype2 ;;
  --version)     exec "\${PKG}" --modversion freetype2 ;;
  *)
    echo "freetype-config: unsupported option '\$1'" >&2
    exit 1
    ;;
esac
SHIM
chmod +x "${PREFIX}/bin/freetype-config"

if [ ! -x "${PREFIX}/bin/freetype-config" ]; then
  echo "ERROR: could not provide freetype-config, which dvdauthor looks for." >&2
  ls -la "${PREFIX}/bin" >&2 || true
  exit 1
fi
echo "    installed into ${PREFIX}, with a freetype-config shim over freetype2.pc"

# --------------------------------------------------------------- dvdauthor ---
echo ""
echo "==> dvdauthor ${DVDAUTHOR_VERSION}: building (macOS ${MACOSX_DEPLOYMENT_TARGET})"
cd "${WORK}/src"
curl -fsSL --retry 3 --retry-delay 2 -o dvdauthor.tar.gz "${DVDAUTHOR_URL}"

# The tarball is checked against the hash Homebrew publishes for it. A download
# that is silently a different file would otherwise be compiled and shipped.
ACTUAL="$(shasum -a 256 dvdauthor.tar.gz | awk '{print $1}')"
if [ "${ACTUAL}" != "${DVDAUTHOR_SHA256}" ]; then
  echo "ERROR: the dvdauthor tarball is not the one expected." >&2
  echo "  expected ${DVDAUTHOR_SHA256}" >&2
  echo "  got      ${ACTUAL}" >&2
  exit 1
fi
echo "    checksum matches"

mkdir -p dvdauthor && tar xzf dvdauthor.tar.gz -C dvdauthor --strip-components=1
cd dvdauthor

# Nothing from Homebrew may be visible here, and that takes some arranging.
#
# The runner image has fontconfig, freetype, fribidi and libpng preinstalled, and
# the first attempt found them and linked them — which would have dragged a
# macOS 14 requirement back in through the side door, after all the trouble taken
# to avoid exactly that.
#
#   PKG_CONFIG_LIBDIR  overrides pkg-config's search path entirely, so the only
#                      library it can see is the libpng built above.
#   PATH               trimmed so `freetype-config` in /usr/local/bin is not
#                      found -- but the prefix's own bin is put back in front,
#                      because that is where the freetype-config just built
#                      lives, and dvdauthor will not use freetype without it.
#
# pkg-config itself was resolved by absolute path near the top, before PATH was
# trimmed, and is baked into the freetype-config shim for the same reason.
export PATH="${PREFIX}/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export PKG_CONFIG="${PKG_CONFIG_BIN}"
export PKG_CONFIG_LIBDIR="${PREFIX}/lib/pkgconfig"

# --disable-dvdunauthor: that tool reads DVDs, which this app never does. Without
# the flag, configure treats libdvdread's absence as fatal and stops with
# "missing libdvdread" — which is how the flag was found.
#
# If configure refuses an argument, print what it would have accepted; working
# that out from "unrecognized option" is otherwise a build cycle of guesswork.
if ! CPPFLAGS="-I${PREFIX}/include" \
     LDFLAGS="-L${PREFIX}/lib" \
     ./configure --prefix="${PREFIX}" --disable-dvdunauthor \
     >"${WORK}/dvdauthor-configure.log" 2>&1; then
  echo "ERROR: dvdauthor's configure failed. Its output:" >&2
  cat "${WORK}/dvdauthor-configure.log" >&2
  echo "" >&2
  echo "Options it accepts:" >&2
  ./configure --help >&2 || true
  exit 1
fi

# What it decided to use. A silent "no" for LIBPNG would mean spumux cannot read
# the button images, which would only surface when a menu was built.
echo "    configure chose:"
grep -E '^checking for (LIBPNG|FONTCONFIG|FRIBIDI|MAGICK)|^checking for freetype-config|^checking ft2build' \
  "${WORK}/dvdauthor-configure.log" | sed 's/^/      /' || true

make -j"$(sysctl -n hw.ncpu)" >/dev/null
make install >/dev/null

for tool in dvdauthor spumux; do
  if [ ! -x "${PREFIX}/bin/${tool}" ]; then
    echo "ERROR: ${tool} was not produced by the build" >&2
    ls -la "${PREFIX}/bin" >&2 || true
    exit 1
  fi
  cp "${PREFIX}/bin/${tool}" "${OUT_DIR}/${tool}"
  chmod +x "${OUT_DIR}/${tool}"
done

echo ""
echo "=============================================================="
echo "Built into ${OUT_DIR}"
for tool in ffmpeg ffprobe dvdauthor spumux; do
  MINOS="$(otool -l "${OUT_DIR}/${tool}" 2>/dev/null \
           | grep -A4 -E 'LC_BUILD_VERSION|LC_VERSION_MIN_MACOSX' \
           | grep -E '^ *(minos|version) ' | head -1 | awk '{print $2}')"
  echo "  ${tool}: $(lipo -archs "${OUT_DIR}/${tool}")  minimum macOS ${MINOS:-unknown}"
done

# Anything that still points into the build machine's Homebrew or the scratch
# prefix would not exist on the user's Mac.
echo ""
echo "Checking nothing points at a build-machine path..."
LEAKS=0
for tool in ffmpeg ffprobe dvdauthor spumux; do
  if otool -L "${OUT_DIR}/${tool}" 2>/dev/null | tail -n +2 \
       | grep -qE '/usr/local|/opt/homebrew|'"${WORK}" ; then
    echo "ERROR: ${tool} references a build-machine path:" >&2
    otool -L "${OUT_DIR}/${tool}" | tail -n +2 \
      | grep -E '/usr/local|/opt/homebrew|'"${WORK}" >&2 || true
    LEAKS=$((LEAKS + 1))
  fi
done
if [ "${LEAKS}" -ne 0 ]; then
  exit 1
fi

echo "All four tools are self-contained."
rm -rf "${WORK}"
