#!/usr/bin/env bash
#
# Make the tools Burnhouse depends on relocatable.
#
# Homebrew's ffmpeg and dvdauthor link against dylibs in /opt/homebrew/lib or
# /usr/local/lib. Those paths exist on the build machine and on nobody else's,
# so an app built there would fail to launch on the user's Mac with a dyld error
# before printing a single character.
#
# This script walks the dependency graph, copies every non-system library into
# <output>/lib, and rewrites the load commands so the binaries find them there.
# The result is self-contained: the Mac it runs on needs nothing installed.
#
# The relative-path scheme matters. A binary in bin/ refers to its libraries as
# @loader_path/../lib/x.dylib, while a library in lib/ referring to another
# library in the same directory uses @loader_path/x.dylib. Getting that wrong
# produces a bundle that works on the build machine and nowhere else — which is
# exactly the failure this script exists to prevent.
#
# Usage: scripts/bundle-deps.sh <output-dir> <binary> [binary...]
#
# macOS only. Invoked by the GitHub Actions build.

set -euo pipefail

# Say where it stopped, not just that it did.
#
# Under `set -e` the script dies on the first command that returns non-zero, and
# prints nothing about which one. From the outside that is a failed step with no
# explanation, which is impossible to act on: the exit status says the walk
# stopped, but not whether it was a missing tool, a missing library, a `find`
# that did not understand an argument, or a rewrite that did not take.
trap 'status=$?; if [ "${status}" -ne 0 ]; then
        echo "ERROR: bundle-deps.sh stopped at line ${LINENO} (exit ${status})" >&2
      fi' ERR

OUT_DIR="${1:?usage: bundle-deps.sh <output-dir> <binary> [binary...]}"
shift

LIB_DIR="${OUT_DIR}/lib"
BIN_DIR="${OUT_DIR}"
mkdir -p "${BIN_DIR}" "${LIB_DIR}"

# Libraries that ship with macOS. These must not be copied: they belong to the
# operating system and bundling them would be both wasteful and wrong.
is_system_lib() {
  case "$1" in
    /usr/lib/*|/System/Library/*) return 0 ;;
    *) return 1 ;;
  esac
}

is_candidate() {
  case "$1" in
    @rpath/*|@loader_path/*|/opt/homebrew/*|/usr/local/*) return 0 ;;
    /*) if is_system_lib "$1"; then return 1; else return 0; fi ;;
    *) return 1 ;;
  esac
}

# Where a library ends up, relative to the file that references it.
ref_for() {
  local referencing_file="$1"
  local library_path="$2"
  local referencing_dir
  referencing_dir="$(dirname "${referencing_file}")"

  if [ "${referencing_dir}" = "${LIB_DIR}" ]; then
    printf '@loader_path/%s' "$(basename "${library_path}")"
  else
    printf '@loader_path/lib/%s' "$(basename "${library_path}")"
  fi
}

# Resolve a load command to a real file on disk.
resolve_ref() {
  local ref="$1"
  local owner_dir="$2"
  local tail candidate

  case "${ref}" in
    @loader_path/*)
      candidate="${owner_dir}/${ref#@loader_path/}"
      [ -e "${candidate}" ] && { printf '%s' "${candidate}"; return 0; }
      ;;
    @rpath/*)
      tail="${ref#@rpath/}"
      for candidate in \
        "${owner_dir}/${tail}" \
        "${owner_dir}/../lib/${tail}" \
        "${LIB_DIR}/${tail}" \
        "/opt/homebrew/lib/${tail}" \
        "/usr/local/lib/${tail}" \
        "/opt/homebrew/opt/ffmpeg/lib/${tail}" \
        "/usr/local/opt/ffmpeg/lib/${tail}" \
        "/opt/homebrew/opt/dvdauthor/lib/${tail}" \
        "/usr/local/opt/dvdauthor/lib/${tail}" \
        "/opt/homebrew/opt/libxml2/lib/${tail}" \
        "/usr/local/opt/libxml2/lib/${tail}"
      do
        [ -e "${candidate}" ] && { printf '%s' "${candidate}"; return 0; }
      done
      ;;
    /*)
      [ -e "${ref}" ] && { printf '%s' "${ref}"; return 0; }
      ;;
  esac
  return 1
}

# Copy a library in, returning its paths on stdout if it was newly copied.
stage_library() {
  local lib_path="$1"
  local base dest
  base="$(basename "${lib_path}")"
  dest="${LIB_DIR}/${base}"

  is_system_lib "${lib_path}" && return 1
  [ -e "${lib_path}" ] || return 1

  if [ ! -e "${dest}" ]; then
    # -L follows symlinks, so the bundle holds real files rather than dangling
    # links into a Homebrew cellar that exists only on the build machine.
    cp -L "${lib_path}" "${dest}"
    chmod u+w "${dest}"
    echo "${dest}"
    return 0
  fi
  return 1
}

patch_file() {
  local target="$1"
  local mode
  # `%p` is the file type AND the permissions: on macOS it prints 100755 for an
  # executable, and chmod refuses that with "Invalid file mode: 100755", which
  # killed this script on the first file it touched. `%Lp` is the permissions
  # alone, which is the thing being saved and restored here.
  mode="$(stat -f '%Lp' "${target}" 2>/dev/null || echo '')"
  [ -n "${mode}" ] || mode='755'
  chmod u+w "${target}"

  # A library's own install name is the second line of `otool -L`, and it has to
  # become relocatable as well: it is what dyld records when something loads this
  # library, so leaving it pointing into a Homebrew cellar that exists on this
  # machine and nowhere else is the very thing this script is here to prevent.
  #
  # `install_name_tool -change` cannot alter it -- that needs `-id`. Feeding the
  # install name to -change is what used to happen, because only the header line
  # was being skipped, and -change quietly did nothing to it. Every library kept a
  # Homebrew path and the final check failed with 21 of them listed. Executables
  # were fine, which is the clue: they have no install name to confuse it.
  local is_lib=0
  case "${target}" in *.dylib) is_lib=1 ;; esac

  if [ "${is_lib}" -eq 1 ]; then
    install_name_tool -id "@loader_path/$(basename "${target}")" "${target}" 2>/dev/null || \
      echo "  warning: could not set the install name of ${target}" >&2
  fi

  local deps dep resolved staged new_ref
  # Skip the header, and for a library its install name too, so only real
  # dependencies are rewritten.
  deps="$(otool -L "${target}" 2>/dev/null | tail -n +$((is_lib + 2)) | awk '{print $1}' || true)"

  while IFS= read -r dep; do
    [ -z "${dep}" ] && continue
    is_candidate "${dep}" || continue

    resolved="$(resolve_ref "${dep}" "$(dirname "${target}")" || true)"
    [ -n "${resolved}" ] || continue

    staged="$(stage_library "${resolved}" || true)"

    # The new reference depends on where the *referencing* file lives.
    new_ref="$(ref_for "${target}" "${resolved}")"
    # Not silenced: a rewrite that does not take is the failure this whole script
    # exists to catch, and hiding the reason for it costs a build cycle to find.
    install_name_tool -change "${dep}" "${new_ref}" "${target}" 2>/tmp/install_name_tool.err || \
      echo "  warning: could not repoint ${dep} in ${target}: $(cat /tmp/install_name_tool.err 2>/dev/null)" >&2

    # Stage any newly discovered library for its own dependencies to be walked.
    if [ -n "${staged}" ]; then
      pending_libs+=("${staged}")
    fi
  done <<< "${deps}"

  # Restoring the mode must never be what stops the build, but it should not be
  # silent either: a binary that comes out non-executable is a failure much
  # later, in the app, and would look like something else entirely.
  chmod "${mode}" "${target}" 2>/dev/null || \
    echo "  warning: could not restore mode ${mode} on ${target}" >&2
}

resign() {
  command -v codesign >/dev/null 2>&1 || return 0
  codesign --force --sign - --timestamp=none "$1" >/dev/null 2>&1 || \
    echo "  warning: could not sign $1" >&2
}

echo "Bundling into ${OUT_DIR}"

for binary in "$@"; do
  [ -e "${binary}" ] || { echo "error: ${binary} does not exist" >&2; exit 1; }
done

# Stage the executables themselves first.
for binary in "$@"; do
  cp -L "${binary}" "${BIN_DIR}/$(basename "${binary}")"
  chmod u+w "${BIN_DIR}/$(basename "${binary}")"
done

pending_libs=()

# Walk the executables, then keep walking until no new libraries appear.
for binary in "$@"; do
  echo "  resolving $(basename "${binary}")"
  patch_file "${BIN_DIR}/$(basename "${binary}")"
done

# Queue of libraries is drained as new ones are discovered. `seen_lib_count`
# guards against a cycle causing an endless loop.
seen_lib_count=0
while true; do
  current_count=$(find "${LIB_DIR}" -type f -name '*.dylib' | wc -l | tr -d ' ')
  if [ "${current_count}" -eq "${seen_lib_count}" ]; then
    break
  fi
  seen_lib_count="${current_count}"

  while IFS= read -r lib; do
    [ -z "${lib}" ] && continue
    patch_file "${lib}"
  done < <(find "${LIB_DIR}" -type f -name '*.dylib' | sort)
done

# Sign libraries first, then the executables that load them.
if [ -d "${LIB_DIR}" ]; then
  while IFS= read -r lib; do
    [ -z "${lib}" ] && continue
    resign "${lib}"
  done < <(find "${LIB_DIR}" -type f -name '*.dylib')
fi

for binary in "$@"; do
  resign "${BIN_DIR}/$(basename "${binary}")"
done

# Anything still pointing at a Homebrew path would fail on the user's machine.
echo "Verifying nothing still points at Homebrew..."
failures=0
while IFS= read -r file; do
  # Which files to check is decided here rather than by `find -perm`, because
  # -perm with a symbolic mode is a GNU extension and this runs on BSD find.
  case "${file}" in
    *.dylib) ;;
    *) [ -x "${file}" ] || continue ;;
  esac

  if otool -L "${file}" 2>/dev/null | tail -n +2 | grep -qE '/opt/homebrew|/usr/local'; then
    echo "ERROR: ${file} still references a Homebrew path:" >&2
    otool -L "${file}" | tail -n +2 | grep -E '/opt/homebrew|/usr/local' >&2 || true
    # Say whether the reference is simply not on disk (nothing we could have
    # copied) or whether it exists and the rewrite failed. Those have different
    # causes and the difference is invisible from the path alone.
    while IFS= read -r still; do
      [ -z "${still}" ] && continue
      if [ -e "${still}" ]; then
        echo "         (the file exists; install_name_tool did not rewrite it)" >&2
      else
        echo "         (the file does not exist on this machine)" >&2
      fi
    done < <(otool -L "${file}" 2>/dev/null | tail -n +2 | grep -E '/opt/homebrew|/usr/local' | awk '{print $1}' || true)
    failures=$((failures + 1))
  fi
done < <(find "${OUT_DIR}" -type f)

if [ "${failures}" -gt 0 ]; then
  echo "Bundling failed: ${failures} file(s) are not relocatable." >&2
  exit 1
fi

echo "Done."
ls -la "${BIN_DIR}"
echo "Libraries (${seen_lib_count}):"
ls -la "${LIB_DIR}"
