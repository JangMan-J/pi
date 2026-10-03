#!/usr/bin/env bash
# Publishes each build of a release to npm as pi-bolt-linux-VARIANT@VERSION: a package that holds the release's .tar.xz, byte
# for byte. The installer downloads it from the npm registry, a CDN that is fast where GitHub's release downloads are slow,
# and checks it against the release's SHA256SUMS on GitHub, as it does a download from GitHub.
#
# Usage: scripts/publish-npm-builds.sh DIST [--pack OUT] [-- NPM PUBLISH OPTIONS]
#   DIST     dist/<version>, as package-release.sh makes it (the .tar.xz files and SHA256SUMS)
#   --pack   only make the packages (.tgz) in OUT, to test them
# A version that npm already has is skipped, so running it again is safe.
source "$(dirname "$0")/lib/common.sh"
need sha256sum

DIST="${1:?usage: scripts/publish-npm-builds.sh DIST [--pack OUT] [-- npm publish options]}"
shift
PACK=""
if [ "${1:-}" = --pack ]; then
	PACK="$(realpath -m "${2:?--pack needs a folder}")"
	shift 2
fi
[ "${1:-}" != -- ] || shift
VERSION="$(basename "$(realpath "$DIST")")"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "$DIST: the folder's name must be the version (dist/X.Y.Z)"
[ -f "$DIST/SHA256SUMS" ] || die "no SHA256SUMS in $DIST"
need npm

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
for variant in x64 x64-baseline x64-jit; do
	name="pi-bolt-linux-$variant"
	file="$name.tar.xz"
	[ -f "$DIST/$file" ] || die "no $file in $DIST"
	(cd "$DIST" && grep " $file\$" SHA256SUMS | sha256sum -c --quiet -) || die "$file does not match SHA256SUMS"
	if [ -z "$PACK" ] && [ "$(npm view "$name@$VERSION" version 2>/dev/null)" = "$VERSION" ]; then
		log "npm already has $name@$VERSION"
		continue
	fi
	dir="$STAGE/$name"
	mkdir -p "$dir"
	cp "$DIST/$file" "$dir/"
	cat >"$dir/package.json" <<EOF
{
	"name": "$name",
	"version": "$VERSION",
	"description": "The Pi-Bolt $VERSION executable (linux-$variant) for its installer. Install Pi-Bolt with the pi-bolt package or install.sh.",
	"homepage": "https://github.com/opensec-git/Pi-Bolt",
	"repository": {
		"type": "git",
		"url": "git+https://github.com/opensec-git/Pi-Bolt.git"
	},
	"license": "MIT",
	"author": "OpenSec",
	"os": ["linux"],
	"cpu": ["x64"],
	"files": ["$file"]
}
EOF
	cat >"$dir/README.md" <<EOF
# $name

\`$file\` of the [Pi-Bolt $VERSION release](https://github.com/opensec-git/Pi-Bolt/releases/tag/bolt-v$VERSION), the same
bytes, for Pi-Bolt's installer to download from the npm registry. Nothing to install from here: use

\`\`\`bash
curl -fsSL https://pi-bolt.opensec.in/install.sh | sh
\`\`\`

or \`npm install -g pi-bolt\`. The installer checks the file against the release's \`SHA256SUMS\` on GitHub.
EOF
	if [ -n "$PACK" ]; then
		mkdir -p "$PACK"
		(cd "$dir" && npm pack --silent --pack-destination "$PACK" >/dev/null)
		log "packed $PACK/$name-$VERSION.tgz"
	else
		(cd "$dir" && npm publish --access public "$@")
		log "published $name@$VERSION"
	fi
done
