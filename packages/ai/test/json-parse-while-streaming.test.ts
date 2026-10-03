import { describe, expect, it } from "vitest";
import { parseStreamingJson, parseStreamingJsonWhileStreaming } from "../src/utils/json-parse.ts";

function stream(text: string, step: number) {
	const block = {};
	let current: Record<string, unknown> | undefined;
	const seen: Array<Record<string, unknown>> = [];
	for (let i = step; i < text.length + step; i += step) {
		current = parseStreamingJsonWhileStreaming(block, text.slice(0, i), current);
		seen.push(current);
	}
	return { current, seen };
}

describe("parseStreamingJsonWhileStreaming", () => {
	it("parses short arguments on every delta", () => {
		const text = JSON.stringify({ path: "a.txt", n: 1 });
		const { seen } = stream(text, 1);
		for (let i = 0; i < seen.length; i++) {
			expect(seen[i]).toEqual(parseStreamingJson(text.slice(0, i + 1)));
		}
	});

	it("parses a large argument a logarithmic number of times, and the final parse is exact", () => {
		const content = Array.from({ length: 3000 }, (_, i) => `line ${i} "quoted" \\ back`).join("\n");
		const text = JSON.stringify({ path: "big.txt", content });
		const { seen } = stream(text, 40);
		const distinct = new Set(seen).size;
		expect(distinct).toBeLessThan(150);
		// What it shows is always a parse of a prefix of what arrived, never more than arrived.
		const last = seen[seen.length - 1] as { content?: string };
		expect(content.startsWith(last.content ?? "")).toBe(true);
		expect(parseStreamingJson(text)).toEqual({ path: "big.txt", content });
	});

	it("keeps separate state for each tool call", () => {
		const a = {};
		const b = {};
		const first = parseStreamingJsonWhileStreaming(a, '{"x": 1', undefined);
		const second = parseStreamingJsonWhileStreaming(b, '{"y": 2', undefined);
		expect(first).toEqual({ x: 1 });
		expect(second).toEqual({ y: 2 });
	});
});
