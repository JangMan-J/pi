#!/usr/bin/env bash
# Prepare a fork checkout for testing and run the checks.
#
#   install-tests.sh            build the pi-env daemon, set up the .fork worktree and agent pointers, run the focused checks
#   install-tests.sh --all      same setup, then `npm run check` and the full `./test.sh` (several minutes)
#   install-tests.sh --no-run   setup only
#
# Options:
#   --dir DIR    checkout directory   PI_DIR   default ~/pi
#
# Needs cargo for packages/env (install with https://rustup.rs). If the checkout is missing, this
# runs install-next.sh from the same directory as this script.
set -euo pipefail

dir="${PI_DIR:-$HOME/pi}"
mode="focused"

while [[ $# -gt 0 ]]; do
	case "$1" in
		--dir) dir="$2"; shift 2 ;;
		--all) mode="all"; shift ;;
		--no-run) mode="none"; shift ;;
		-h|--help) sed -n '2,12p' "$0"; exit 0 ;;
		*) echo "unknown argument: $1" >&2; exit 2 ;;
	esac
done

say() { printf '\n==> %s\n' "$*"; }
die() { printf 'install-tests: %s\n' "$*" >&2; exit 1; }
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ ! -d "$dir/.git" ]]; then
	[[ -x "$here/install-next.sh" ]] || die "$dir is not a checkout and $here/install-next.sh is missing"
	PI_DIR="$dir" "$here/install-next.sh"
fi
cd "$dir"

if [[ ! -d node_modules ]]; then
	say "Installing dependencies (npm ci --ignore-scripts)"
	npm ci --ignore-scripts
fi
if [[ ! -f packages/coding-agent/dist/cli.js || ! -d packages/ai/dist ]]; then
	if ! npm --prefix packages/ai run check:model-data >/dev/null 2>&1; then
		say "Hydrating model data (npm run hydrate:model-data, needs network)"
		npm run hydrate:model-data
	fi
	say "Building packages (npm run build:offline)"
	npm run build:offline
fi

say "Building the pi-env daemon"
command -v cargo >/dev/null 2>&1 || die "cargo is required for packages/env tests; install it with: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
(cd packages/env && npm run build:daemon)

say "Setting up .fork tooling worktree"
if [[ -d .fork && ! -e .fork/.git ]]; then
	# An older, untracked copy of the tooling. Keep it, but out of the way.
	aside=".fork.old-$(date -u +%Y%m%dT%H%M%SZ)"
	mv .fork "$aside"
	grep -qx "$aside" .git/info/exclude 2>/dev/null || echo "$aside" >> .git/info/exclude
	echo "moved untracked .fork to $aside"
fi
if [[ -d .fork/.git || -f .fork/.git ]]; then
	git -C .fork pull -q --ff-only origin fork-tooling
else
	git fetch -q origin fork-tooling
	git branch -q --track fork-tooling origin/fork-tooling 2>/dev/null || true
	git worktree add -q .fork fork-tooling
fi
grep -qx '.fork' .git/info/exclude 2>/dev/null || echo '.fork' >> .git/info/exclude
chmod +x .fork/sync.sh .fork/check.sh

say "Creating or aligning local main, feature branches and next from origin"
.fork/sync.sh --align

say "Pointing agents at .fork/AGENTS.md"
# Claude Code reads CLAUDE.local.md from the repo root; keep it out of git.
cat > CLAUDE.local.md <<'MD'
# Fork workflow
This checkout is the JangMan-J/pi fork. Before changing or committing anything, read `.fork/AGENTS.md`
(branch ownership and the order of operations) and run `.fork/sync.sh --status`. Never commit on `main` or `next`.
MD
grep -qx 'CLAUDE.local.md' .git/info/exclude 2>/dev/null || echo 'CLAUDE.local.md' >> .git/info/exclude
# pi reads ~/.pi/agent/AGENTS.md in every directory; add one guarded pointer block.
pi_agents="${PI_AGENT_DIR:-$HOME/.pi/agent}/AGENTS.md"
if [[ -d "$(dirname "$pi_agents")" ]] && ! grep -q 'fork-workflow:JangMan-J/pi' "$pi_agents" 2>/dev/null; then
	cat >> "$pi_agents" <<MD

<!-- fork-workflow:JangMan-J/pi -->
## JangMan-J/pi fork checkouts
When the working directory is a checkout of JangMan-J/pi (it has a \`.fork/\` directory), read \`.fork/AGENTS.md\`
before changing anything and run \`.fork/sync.sh --status\` first. Commit only on the owning branch, never on \`main\` or \`next\`.
<!-- /fork-workflow -->
MD
	echo "added pointer block to $pi_agents"
fi

case "$mode" in
	focused) say "Running focused checks"; .fork/check.sh focused ;;
	all) say "Running npm run check and ./test.sh"; .fork/check.sh all ;;
	none) say "Setup complete; run .fork/check.sh focused or .fork/check.sh all" ;;
esac
