/**
 * The `codemode` tool as an extension. The CLI loads it as a built-in extension; SDK users
 * add `createCodemodeExtension()` to their extension factories.
 *
 * `codemode` is registered inactive. Activate it with `--tools`, the `defaultTools` setting, or
 * `setActiveTools()`; the MCP extension activates it when MCP tools are only reachable from scripts.
 *
 * `/codemode [on|only|reset]` switches the presentation for the current session without changing
 * settings; `/codemode` alone reports it.
 */

import type { ExtensionAPI, ExtensionFactory } from "../../core/extensions/types.ts";
import { SETTINGS_DEFAULTS } from "../../core/settings-defaults.ts";
import type { CodemodeMode } from "../../core/settings-manager.ts";
import { createCodemodeToolDefinition } from "./tool.ts";

export interface CodemodeExtensionOptions {
	/** Overrides the `codemode.mode` setting. */
	mode?: CodemodeMode;
	/** Overrides the `codemode.inlineBudget` setting. */
	inlineBudget?: number;
	/** Expose the model catalog and classifiers to scripts as `models`. Default: `true`. */
	models?: boolean;
}

function readMode(pi: ExtensionAPI): CodemodeMode {
	return pi.getSettings().codemode?.mode === "only" ? "only" : SETTINGS_DEFAULTS.codemode.mode;
}

function readInlineBudget(pi: ExtensionAPI): number | undefined {
	const budget = pi.getSettings().codemode?.inlineBudget;
	return typeof budget === "number" && Number.isFinite(budget) && budget >= 0 ? budget : undefined;
}

const COMMAND_ARGUMENTS = [
	{ value: "on", label: "on", description: "Declare direct tools; codemode lists the rest" },
	{ value: "only", label: "only", description: "Route every tool through codemode for this session" },
	{ value: "reset", label: "reset", description: "Return to the codemode.mode setting" },
	{ value: "status", label: "status", description: "Show the current mode" },
];

export function createCodemodeExtension(options: CodemodeExtensionOptions = {}): ExtensionFactory {
	return (pi) => {
		/** Session-only override from `/codemode`; it wins over the option and the setting. */
		let sessionMode: CodemodeMode | undefined;
		const currentMode = (): CodemodeMode => sessionMode ?? options.mode ?? readMode(pi);
		const describeMode = (): string => {
			const source = sessionMode ? "this session" : options.mode ? "extension option" : "codemode.mode setting";
			const active = pi.getActiveTools().includes("codemode") ? "" : "; the codemode tool is not active";
			return `codemode mode: ${currentMode()} (${source})${active}`;
		};

		pi.registerTool({
			...createCodemodeToolDefinition({
				appendEntry: (customType, data) => pi.appendEntry(customType, data),
				models: options.models ?? true,
				getToolNamespace: (name) => pi.getAllTools().find((tool) => tool.name === name)?.namespace,
				getToolGuidelines: () =>
					new Map(pi.getAllTools().map((tool) => [tool.name, tool.promptGuidelines ?? []] as const)),
				getMode: currentMode,
				getInlineBudget: () => options.inlineBudget ?? readInlineBudget(pi),
			}),
			defaultActive: false,
		});

		pi.registerCommand("codemode", {
			description: "Show or switch how codemode presents tools for this session: on, only, or reset",
			getArgumentCompletions: (prefix) => COMMAND_ARGUMENTS.filter((item) => item.value.startsWith(prefix.trim())),
			handler: async (args, ctx) => {
				const choice = args.trim().toLowerCase();
				if (choice === "" || choice === "status") {
					ctx.ui.notify(describeMode(), "info");
					return;
				}
				if (choice !== "on" && choice !== "only" && choice !== "reset") {
					ctx.ui.notify(`Unknown argument "${args.trim()}". Use /codemode on, only, reset, or status.`, "warning");
					return;
				}
				const previous = currentMode();
				sessionMode = choice === "reset" ? undefined : choice;
				// The mode is applied when the tool loadout is prepared, so re-apply the active tools.
				// "only" needs the codemode tool itself, since it hides the direct declarations.
				const active = pi.getActiveTools();
				pi.setActiveTools(
					currentMode() === "only" && !active.includes("codemode") ? [...active, "codemode"] : active,
				);
				const changed = currentMode() !== previous;
				ctx.ui.notify(
					changed
						? `${describeMode()}. The next request re-sends the tool list, so expect one prompt-cache miss.`
						: describeMode(),
					"info",
				);
			},
		});
	};
}

export default createCodemodeExtension();
