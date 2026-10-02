#!/usr/bin/env bash
# Records a training profile for a Pi version: which functions run and in which order (the executable lays them out together,
# so starting touches fewer pages), and the regular expressions Pi builds from strings at run time (compiled into the image like
# literals). A profile belongs to one Pi version and one entry point; scripts/build-pi.sh picks profiles/pi-<version> up.
# Usage: scripts/train-profile.sh [--pi DIR] [--plugins FILE] [--out DIR]
#   --plugins FILE    train the build that has these extensions compiled in (scripts/build-pi.sh --plugins): give the profile its
#                     own --out, and pass it to build-pi.sh with --profile
source "$(dirname "$0")/lib/common.sh"
PI_DIR="$PIBOLT_PI"; PLUGINS=""; OUT=""
while [ $# -gt 0 ]; do
	case "$1" in
	--pi) PI_DIR="$2"; shift ;;
	--plugins) PLUGINS="$2"; shift ;;
	--out) OUT="$2"; shift ;;
	*) die "unknown option $1" ;;
	esac
	shift
done
BUN="$(runtime_bun)"
AGENT="$(pi_agent_dir "$PI_DIR")"
VERSION="$(pi_version "$AGENT")"
OUT="$(realpath -m "${OUT:-$PIBOLT_ROOT/profiles/pi-$VERSION}")"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP" "$AGENT/.pibolt-plugins"' EXIT
ENTRY=""
[ -n "$PLUGINS" ] && ENTRY="$(stage_plugins "$AGENT" "$PLUGINS")"
mapfile -t ENTRIES < <(pi_entries "$AGENT" "$ENTRY")

log "a bytecode build of Pi $VERSION to train with"
(cd "$AGENT" && "$BUN" build --compile --no-compile-autoload-bunfig --target=bun-linux-x64 --bytecode --format=esm "${ENTRIES[@]}" --outfile "$TMP/pi" >/dev/null)
log "training session"
python3 "$PIBOLT_ROOT/scripts/lib/train_session.py" "$TMP/pi" "$TMP/bytecode.order" "$TMP/regexps.txt"
mkdir -p "$OUT"
cp "$TMP/bytecode.order" "$OUT/bytecode.order"
sort -u "$TMP/regexps.txt" > "$OUT/regexps.txt"
log "profile: $OUT ($(wc -l < "$OUT/regexps.txt") regular expressions)"
