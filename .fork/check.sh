#!/usr/bin/env bash
# Checks for the fork's integration branch.
#
#   .fork/check.sh focused   sync regression and provider payload tests touched by the fork (fast, no network)
#   .fork/check.sh all       npm run check (biome, tsc, pinned deps) and the full ./test.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && git rev-parse --show-toplevel)"
cd "$repo"

# The standalone-process tests spawn plain node on source files, which resolve workspace packages
# through their package.json exports (dist/). Build any such dependency of pi-ai / pi-virtual-models
# depth-first in topological order so transitive dependencies (e.g. pi-codemode -> pi-durable) exist first.
ensure_pkg_built() {
	local dir="$1"
	[[ -d "$dir" && -f "$dir/package.json" ]] || return 0
	[[ ! -d "$dir/dist" ]] || return 0
	local dep dep_dir
	for dep in $(node -e 'const p=require("node:path").resolve(process.argv[1]);const d=require(p);console.log(Object.keys({...d.dependencies,...d.peerDependencies}).filter(k=>k.startsWith("@earendil-works/")&&k!==d.name).join(" "))' "$dir/package.json"); do
		dep_dir="$(readlink -f "node_modules/$dep" 2>/dev/null || true)"
		[[ -n "$dep_dir" && -d "$dep_dir" ]] && ensure_pkg_built "$dep_dir"
	done
	local name
	name="$(node -p 'require(require("node:path").resolve(process.argv[1])).name' "$dir/package.json")"
	echo "building $name (dist missing)"
	if [[ "$name" == "@earendil-works/pi-ai" ]]; then
		npm --prefix "$dir" run check:model-data >/dev/null 2>&1 || node "$here/hydrate-models.mjs" >/dev/null
		(cd "$dir" && npm run build:offline >/dev/null)
	else
		(cd "$dir" && npm run build >/dev/null)
	fi
}

ensure_ai_deps_built() {
	ensure_pkg_built "packages/ai"
	if [[ -d "packages/virtual-models" ]]; then
		ensure_pkg_built "packages/virtual-models"
	fi
}

case "${1:-focused}" in
	focused)
		"$here/test-sync.sh"
		ai_tests=(
			antigravity-native antigravity-images antigravity-catalog antigravity-oauth
			anthropic-oauth-payload anthropic-model-generation anthropic-oauth-security anthropic-oauth-system-prompt
			anthropic-force-adaptive-thinking anthropic-temperature-compat anthropic-mid-conversation-effort
			anthropic-thinking-disable anthropic-oauth oauth-callback-server anthropic-sse-parsing
			google-shared-gemini3-unsigned-tool-call google-shared-convert-tools
			google-thinking-level-map google-raw-stop-reason google-stop-reason-continuation meta-oauth
			generic-endpoint-provider
			openai-responses-mid-convo-effort openai-codex-stream openai-responses-compat
			openai-completions-tool-choice images-models
			native-providers-catalog native-providers-kimi-wire
		)
		core_agent_tests=(agent-loop agent-request-update)
		durable_tests=(harness-compaction harness-generation-recovery)
		virtual_models_tests=(
			study-notes predicates stream-shaping route-exec virtual-models-runtime
			virtual-models-durable seed-checkpointed-conversation sliding-window-realpath
			node-fork-export storage-runtime-boundary sw-recall-tool sw-tool-hooks
			sw-router sw-baton-lifecycle sliding-window sliding-window-recall-ledger
		)
		agent_tests=(
			add-endpoint-provider remote-catalog-names anthropic-oauth-prompt-drift references
			virtual-models interactive-mode-suppressed-messages
			suite/virtual-models suite/virtual-model-substrate suite/suppress-text-display
			suite/regressions/11156-pi-ai-models-virtual-module
		)
		# vitest skips a listed file that does not exist, so a branch missing from next would pass silently.
		missing=()
		for t in "${ai_tests[@]}"; do [[ -f "packages/ai/test/$t.test.ts" ]] || missing+=("packages/ai/test/$t.test.ts"); done
		for t in "${core_agent_tests[@]}"; do [[ -f "packages/agent/test/$t.test.ts" ]] || missing+=("packages/agent/test/$t.test.ts"); done
		for t in "${durable_tests[@]}"; do [[ -f "packages/durable/test/$t.test.ts" ]] || missing+=("packages/durable/test/$t.test.ts"); done
		for t in "${virtual_models_tests[@]}"; do [[ -f "packages/virtual-models/test/$t.test.ts" ]] || missing+=("packages/virtual-models/test/$t.test.ts"); done
		for t in "${agent_tests[@]}"; do [[ -f "packages/coding-agent/test/$t.test.ts" ]] || missing+=("packages/coding-agent/test/$t.test.ts"); done
		if [[ ${#missing[@]} -gt 0 ]]; then
			printf 'focused test file missing (is its branch merged into this checkout?): %s\n' "${missing[@]}" >&2
			exit 1
		fi
		ensure_ai_deps_built
		(cd packages/ai && npx vitest run "${ai_tests[@]/#/test/}")
		(cd packages/agent && npx vitest run "${core_agent_tests[@]/#/test/}")
		(cd packages/durable && npx vitest run "${durable_tests[@]/#/test/}")
		(cd packages/virtual-models && npx vitest run "${virtual_models_tests[@]/#/test/}")
		(cd packages/coding-agent && npx vitest run "${agent_tests[@]/#/test/}")
		;;
	all)
		npm run check
		./test.sh
		;;
	*)
		echo "usage: $0 [focused|all]" >&2
		exit 2
		;;
esac
