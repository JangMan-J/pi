#!/usr/bin/env bash
# Clone or update the fork's `next` branch, build it, and point `pi` at the build.
#
#   install-next.sh                  clone (or update) ~/pi, hydrate model data if missing, build, link ~/.local/bin/pi
#   install-next.sh --refresh-models run `npm run build` instead, which refreshes model data over the network first
#   install-next.sh --force          allow replacing a local `next` that has commits origin does not have
#
# Options (flags override the environment):
#   --dir DIR        checkout directory            PI_DIR      default ~/pi
#   --repo URL       fork to clone                 PI_REPO     default https://github.com/JangMan-J/pi.git
#   --branch NAME    branch to install             PI_BRANCH   default next
#   --bin-dir DIR    where the `pi` symlink goes   PI_BIN_DIR  default ~/.local/bin
#
# `next` is force-pushed by .fork/sync.sh, so the update path resets the local branch to origin
# instead of pulling. It refuses to do that on a dirty tree, or over local-only commits without --force.
set -euo pipefail

dir="${PI_DIR:-$HOME/pi}"
repo="${PI_REPO:-https://github.com/JangMan-J/pi.git}"
branch="${PI_BRANCH:-next}"
bin_dir="${PI_BIN_DIR:-$HOME/.local/bin}"
upstream_url="https://github.com/earendil-works/pi.git"
build_script="build:offline"
force=0

while [[ $# -gt 0 ]]; do
	case "$1" in
		--dir) dir="$2"; shift 2 ;;
		--repo) repo="$2"; shift 2 ;;
		--branch) branch="$2"; shift 2 ;;
		--bin-dir) bin_dir="$2"; shift 2 ;;
		--refresh-models) build_script="build"; shift ;;
		--offline) build_script="build:offline"; shift ;;
		--force) force=1; shift ;;
		-h|--help) sed -n '2,16p' "$0"; exit 0 ;;
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

if [[ ! -d "$dir/.git" ]]; then
	say "Cloning $repo ($branch) into $dir"
	git clone --branch "$branch" "$repo" "$dir"
else
	say "Updating $dir to origin/$branch"
	origin_url="$(git -C "$dir" remote get-url origin 2>/dev/null || true)"
	[[ "$origin_url" == "$repo" ]] || echo "note: origin is $origin_url, not $repo" >&2
	[[ -z "$(git -C "$dir" status --porcelain)" ]] || die "$dir has uncommitted changes; commit, stash, or discard them first"
	git -C "$dir" fetch --prune origin
	if git -C "$dir" rev-parse -q --verify "refs/heads/$branch" >/dev/null; then
		ahead="$(git -C "$dir" rev-list --count "origin/$branch..$branch")"
		if [[ "$ahead" -gt 0 && $force -eq 0 ]]; then
			die "local $branch has $ahead commit(s) origin lacks; push them or re-run with --force"
		fi
	fi
	git -C "$dir" checkout -q -B "$branch" "origin/$branch"
fi

if ! git -C "$dir" remote get-url upstream >/dev/null 2>&1; then
	git -C "$dir" remote add upstream "$upstream_url"
fi

cd "$dir"
say "Installing dependencies (npm ci --ignore-scripts)"
npm ci --ignore-scripts

if [[ "$build_script" == "build:offline" ]]; then
	# packages/ai/src/providers/data/ is gitignored; a fresh clone has to fetch it once.
	if ! npm --prefix packages/ai run check:model-data >/dev/null 2>&1; then
		say "Hydrating model data (npm run hydrate:model-data, needs network)"
		npm run hydrate:model-data
	fi
fi

say "Building (npm run $build_script)"
npm run "$build_script"

cli="$dir/packages/coding-agent/dist/cli.js"
[[ -f "$cli" ]] || die "build finished but $cli is missing"
mkdir -p "$bin_dir"
ln -sfn "$cli" "$bin_dir/pi"
say "Linked $bin_dir/pi -> $cli"

case ":$PATH:" in
	*":$bin_dir:"*) ;;
	*) echo "note: $bin_dir is not on PATH" >&2 ;;
esac

printf '\npi %s at %s (%s)\n' "$(node "$cli" --version)" "$(git rev-parse --short HEAD)" "$branch"
