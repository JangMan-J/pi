#!/usr/bin/env bash
# Install the fork's `next` branch as a tested release and point `pi` at it.
#
#   install-next.sh              build the current origin/next commit in its own release folder, run the
#                                focused checks, then switch `pi` to it; a failed build never replaces pi
#   install-next.sh --rollback   switch `pi` back to the previous release
#   install-next.sh --reinstall  rebuild the current origin/next commit even if it is installed
#
# Options (flags override the environment):
#   --root DIR       releases live here            PI_INSTALL_ROOT  default ~/.local/share/pi-fork
#   --repo URL       fork to clone                 PI_REPO          default https://github.com/JangMan-J/pi.git
#   --branch NAME    branch to install             PI_BRANCH        default next
#   --bin-dir DIR    where the `pi` symlink goes   PI_BIN_DIR       default ~/.local/bin
#
# Layout: releases/<commit>/ holds one commit (shallow), built, with fork-sync's check.sh in .fork/.
# `current` and `previous` are symlinks to releases, and `pi` links through `current`, so a switch is
# one rename and running sessions keep their files. A release whose checks fail stays unmarked for
# inspection and never becomes current. After a switch, releases other than current and previous
# are deleted. To change the fork, set up a development checkout with install-tests.sh instead.
set -euo pipefail

root="${PI_INSTALL_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/pi-fork}"
repo="${PI_REPO:-https://github.com/JangMan-J/pi.git}"
branch="${PI_BRANCH:-next}"
bin_dir="${PI_BIN_DIR:-$HOME/.local/bin}"
mode="install"

while [[ $# -gt 0 ]]; do
	case "$1" in
		--root) root="$2"; shift 2 ;;
		--repo) repo="$2"; shift 2 ;;
		--branch) branch="$2"; shift 2 ;;
		--bin-dir) bin_dir="$2"; shift 2 ;;
		--rollback) mode="rollback"; shift ;;
		--reinstall) mode="reinstall"; shift ;;
		-h|--help) sed -n '2,19p' "$0"; exit 0 ;;
		*) echo "unknown argument: $1" >&2; exit 2 ;;
	esac
done

say() { printf '\n==> %s\n' "$*"; }
die() { printf 'install-next: %s\n' "$*" >&2; exit 1; }

for tool in git node npm; do
	command -v "$tool" >/dev/null 2>&1 || die "$tool is required"
done
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$node_major" -ge 22 ]] || die "Node 22.19 or newer is required (found $(node --version))"

mkdir -p "$root/releases"
root="$(cd "$root" && pwd -P)"
cli_path="packages/coding-agent/dist/cli.js"

target_of() { readlink "$root/$1" 2>/dev/null || true; }
# Point `current` or `previous` at a release with one rename, so readers never see it missing.
point() {
	ln -sfn "$2" "$root/.$1.tmp"
	mv -T "$root/.$1.tmp" "$root/$1"
}
link_pi() {
	mkdir -p "$bin_dir"
	ln -sfn "$root/current/$cli_path" "$bin_dir/pi"
	case ":$PATH:" in
		*":$bin_dir:"*) ;;
		*) echo "note: $bin_dir is not on PATH" >&2 ;;
	esac
	printf '\npi %s at %s (%s)\n' "$(node "$root/current/$cli_path" --version)" \
		"$(basename "$(target_of current)" | cut -c1-9)" "$bin_dir/pi"
}

if [[ "$mode" == "rollback" ]]; then
	current="$(target_of current)"
	previous="$(target_of previous)"
	[[ -n "$previous" && -f "$previous/.installed" ]] || die "there is no previous release to roll back to"
	point current "$previous"
	point previous "$current"
	say "Rolled back to $(basename "$previous")"
	link_pi
	exit 0
fi

say "Resolving $branch on $repo"
commit="$(git ls-remote --exit-code "$repo" "refs/heads/$branch" | cut -f1)" || die "cannot resolve $branch on $repo"
release="$root/releases/$commit"

if [[ "$mode" == "install" && -f "$release/.installed" && "$(target_of current)" == "$release" ]]; then
	say "${commit:0:9} is already the current release"
	link_pi
	exit 0
fi

if [[ "$mode" == "reinstall" || ! -f "$release/.installed" ]]; then
	if [[ "$(target_of current)" == "$release" ]]; then
		die "cannot rebuild ${commit:0:9} while it is the current release; running sessions use it"
	fi
	rm -rf "$release"
	say "Fetching $branch at ${commit:0:9} into $release"
	git init -q "$release"
	git -C "$release" remote add origin "$repo"
	git -C "$release" fetch -q --depth 1 origin "$commit"
	git -C "$release" checkout -q --detach FETCH_HEAD
	# check.sh lives on fork-sync and finds the checkout as the parent of its own directory.
	git -C "$release" fetch -q --depth 1 origin fork-sync
	mkdir -p "$release/.fork"
	git -C "$release" show FETCH_HEAD:check.sh > "$release/.fork/check.sh"
	chmod +x "$release/.fork/check.sh"

	cd "$release"
	say "Installing dependencies (npm ci --ignore-scripts)"
	npm ci --ignore-scripts
	# packages/ai/src/providers/data/ is gitignored; a new release always generates it.
	say "Hydrating model data (npm run hydrate:model-data, needs network)"
	npm run hydrate:model-data
	say "Building (npm run build:offline)"
	npm run build:offline
	[[ -f "$release/$cli_path" ]] || die "build finished but $release/$cli_path is missing"
	say "Running focused checks"
	.fork/check.sh focused || die "focused checks failed; pi is unchanged and the failed build stays at $release"
	touch "$release/.installed"
	cd "$root"
fi

current="$(target_of current)"
point current "$release"
if [[ -n "$current" && "$current" != "$release" ]]; then
	point previous "$current"
fi
say "Switched to ${commit:0:9}"
link_pi

keep_current="$(target_of current)"
keep_previous="$(target_of previous)"
for dir in "$root"/releases/*/; do
	dir="${dir%/}"
	[[ "$dir" == "$keep_current" || "$dir" == "$keep_previous" ]] || { rm -rf "$dir"; echo "removed old release $(basename "$dir")"; }
done
