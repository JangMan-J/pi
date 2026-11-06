/** Load with pi -e ./packages/coding-agent/examples/extensions/stationarity.ts. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const READ_TOOLS = new Set(["read", "read_file", "view_file", "todo", "todo_write", "todowrite"]);
export const STATIONARITY_REMINDER =
	"You have called the same tool with identical arguments repeatedly. Do not repeat the same call; take the next concrete action or try a different approach.";

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(",")}}`;
}

export default function stationarity(pi: ExtensionAPI) {
	pi.on("turn_end", (event) => {
		if (event.outcome !== "completed" || event.toolResults.length === 0) return;
		let signature: string | undefined;
		let count = 0;
		let threshold = 8;
		for (const message of [...event.context.llmMessages].reverse()) {
			if (message.role === "toolResult") continue;
			if (message.role !== "assistant") break;
			const calls = message.content.filter((block) => block.type === "toolCall");
			if (calls.length !== 1) break;
			const call = calls[0];
			const current = `${call.name}:${canonicalJson(call.arguments)}`;
			if (signature !== undefined && signature !== current) break;
			signature = current;
			threshold = READ_TOOLS.has(call.name.toLowerCase()) ? 4 : 8;
			count++;
		}
		if (count < threshold) return;
		// Steering is persisted before the next request, including tool continuations.
		// The persisted user message also resets the count after resume or branching.
		pi.sendUserMessage(STATIONARITY_REMINDER, { deliverAs: "steer" });
	});
}
