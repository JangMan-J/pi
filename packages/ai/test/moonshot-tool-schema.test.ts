import { beforeEach, describe, expect, it, vi } from "vitest";
import { toMoonshotToolSchema } from "../src/api/moonshot-tool-schema.ts";
import { getModel, streamSimple } from "../src/compat.ts";
import type { Model, Tool } from "../src/types.ts";

const mockState = vi.hoisted(() => ({ lastParams: undefined as unknown }));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: unknown) => {
					mockState.lastParams = params;
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield {
								choices: [{ delta: {}, finish_reason: "stop" }],
								usage: { prompt_tokens: 1, completion_tokens: 1 },
							};
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{ data: typeof stream; response: { status: number; headers: Headers } }>;
					};
					promise.withResponse = async () => ({ data: stream, response: { status: 200, headers: new Headers() } });
					return promise;
				},
			},
		};
	}
	return { default: FakeOpenAI };
});

// Jing's jing_delegate inputSchema as its MCP server lists it (tools/list, 2026-11-13). Kimi Coding rejected it with
// 400 "At path 'properties.surface': type is not defined".
const JING_DELEGATE = {
	type: "object",
	properties: {
		lane: { enum: ["errand", "fast", "fog"] },
		module: { type: "string" },
		files: { items: { type: "string" }, type: "array" },
		task: { type: "string" },
		tasks: {
			type: "array",
			items: {
				type: "object",
				properties: {
					lane: { enum: ["errand", "fast", "fog"] },
					task: { type: "string" },
					cells: { items: { type: "string" }, type: "array" },
				},
				required: ["task"],
			},
		},
		surface: { enum: ["pane", "headless"] },
		budgetMs: { type: "integer" },
	},
};

// Jing's jing_plan: a required untyped enum beside an array without items.
const JING_PLAN = {
	type: "object",
	properties: {
		action: { enum: ["publish", "update", "show"] },
		objective: { type: "string" },
		steps: { type: "array" },
	},
	required: ["action"],
};

function deepFreeze<T>(value: T): T {
	if (typeof value === "object" && value !== null) {
		for (const child of Object.values(value)) deepFreeze(child);
		Object.freeze(value);
	}
	return value;
}

type Schema = Record<string, any>;

describe("toMoonshotToolSchema", () => {
	it("types Jing's jing_delegate enums, including the nested tasks[].lane", () => {
		const out = toMoonshotToolSchema(deepFreeze(structuredClone(JING_DELEGATE))) as Schema;
		expect(out.properties.lane).toEqual({ type: "string", enum: ["errand", "fast", "fog"] });
		expect(out.properties.surface).toEqual({ type: "string", enum: ["pane", "headless"] });
		expect(out.properties.tasks.items.properties.lane).toEqual({ type: "string", enum: ["errand", "fast", "fog"] });
		expect(out.properties.tasks.items.required).toEqual(["task"]);
	});

	it("types jing_plan's required action and leaves the untyped-items array alone", () => {
		const out = toMoonshotToolSchema(JING_PLAN) as Schema;
		expect(out.properties.action).toEqual({ type: "string", enum: ["publish", "update", "show"] });
		expect(out.properties.steps).toBe(JING_PLAN.properties.steps);
		expect(out.required).toBe(JING_PLAN.required);
	});

	it("never mutates the caller's schema and shares unchanged nodes", () => {
		const input = deepFreeze(structuredClone(JING_DELEGATE));
		const before = JSON.stringify(input);
		const out = toMoonshotToolSchema(input) as Schema;
		expect(JSON.stringify(input)).toBe(before);
		expect(out).not.toBe(input);
		expect(out.properties.module).toBe(input.properties.module);
		expect(out.properties.files).toBe(input.properties.files);
	});

	it("returns an already accepted schema as the same object", () => {
		const schema = {
			type: "object",
			properties: {
				a: { type: "string", enum: ["x"] },
				b: { anyOf: [{ type: "number" }, { type: "null" }] },
				c: { const: "x" },
				d: { type: ["string", "null"], enum: ["x", null] },
				e: { type: "object", additionalProperties: true },
			},
		};
		expect(toMoonshotToolSchema(schema)).toBe(schema);
	});

	it("infers the type of integer, number and boolean enums", () => {
		const out = toMoonshotToolSchema({
			type: "object",
			properties: { i: { enum: [1, 2] }, n: { enum: [1, 2.5] }, b: { enum: [true, false] } },
		}) as Schema;
		expect(out.properties.i).toEqual({ type: "integer", enum: [1, 2] });
		expect(out.properties.n).toEqual({ type: "number", enum: [1, 2.5] });
		expect(out.properties.b).toEqual({ type: "boolean", enum: [true, false] });
	});

	it("types a nullable enum as [type, null]", () => {
		const out = toMoonshotToolSchema({ type: "object", properties: { a: { enum: ["x", null] } } }) as Schema;
		expect(out.properties.a).toEqual({ type: ["string", "null"], enum: ["x", null] });
	});

	it("splits a mixed enum into typed anyOf branches, keeping its description", () => {
		const out = toMoonshotToolSchema({
			type: "object",
			properties: { a: { description: "d", type: ["string", "integer", "null"], enum: ["x", 1, null] } },
		}) as Schema;
		expect(out.properties.a).toEqual({
			description: "d",
			anyOf: [{ type: "string", enum: ["x"] }, { type: "integer", enum: [1] }, { type: "null" }],
		});
	});

	it("types untyped enums in anyOf, items, additionalProperties, $defs and definitions", () => {
		const out = toMoonshotToolSchema({
			type: "object",
			$defs: { S: { enum: ["x"] } },
			definitions: { T: { enum: ["y"] } },
			properties: {
				a: { anyOf: [{ enum: ["x"] }, { type: "null" }] },
				b: { type: "array", items: { enum: ["x"] } },
				c: { type: "object", additionalProperties: { enum: ["x"] } },
			},
		}) as Schema;
		expect(out.$defs.S).toEqual({ type: "string", enum: ["x"] });
		expect(out.definitions.T).toEqual({ type: "string", enum: ["y"] });
		expect(out.properties.a.anyOf[0]).toEqual({ type: "string", enum: ["x"] });
		expect(out.properties.b.items).toEqual({ type: "string", enum: ["x"] });
		expect(out.properties.c.additionalProperties).toEqual({ type: "string", enum: ["x"] });
	});

	it("rewrites an empty enum as not: {}", () => {
		const out = toMoonshotToolSchema({ type: "object", properties: { a: { type: "string", enum: [] } } }) as Schema;
		expect(out.properties.a).toEqual({ type: "string", not: {} });
	});

	it("rewrites tuple items as prefixItems, with additionalItems as items", () => {
		const out = toMoonshotToolSchema({
			type: "object",
			properties: { a: { type: "array", items: [{ enum: ["x"] }], additionalItems: false } },
		}) as Schema;
		expect(out.properties.a).toEqual({ type: "array", prefixItems: [{ type: "string", enum: ["x"] }], items: false });
	});
});

describe("openai-completions tool schemas on Moonshot endpoints", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
	});

	const tool: Tool = {
		name: "jing_delegate",
		description: "Delegate a task.",
		parameters: JING_DELEGATE as unknown as Tool["parameters"],
	};

	async function sentParameters(model: Model<"openai-completions">): Promise<Schema> {
		const before = JSON.stringify(JING_DELEGATE);
		await streamSimple(
			model,
			{ messages: [{ role: "user", content: "Hi", timestamp: Date.now() }], tools: [tool] },
			{ apiKey: "test" },
		).result();
		expect(JSON.stringify(JING_DELEGATE)).toBe(before);
		const params = mockState.lastParams as { tools: Array<{ function: { parameters: Schema } }> };
		return params.tools[0].function.parameters;
	}

	for (const modelId of [
		"k3",
		"k3-256k",
		"k3.1-pro",
		"k3.1-pro-highspeed",
		"kimi-for-coding",
		"kimi-for-coding-highspeed",
	]) {
		it(`types enums for kimi-coding/${modelId}`, async () => {
			const model = getModel("kimi-coding", modelId as never) as Model<"openai-completions">;
			const parameters = await sentParameters(model);
			expect(parameters.properties.lane.type).toBe("string");
			expect(parameters.properties.surface.type).toBe("string");
			expect(parameters.properties.tasks.items.properties.lane.type).toBe("string");
		});
	}

	it("types enums for moonshotai", async () => {
		const model = getModel("moonshotai", "kimi-k3" as never) as Model<"openai-completions">;
		expect((await sentParameters(model)).properties.lane.type).toBe("string");
	});

	// Kimi Code 2.5.2 sends to api.kimi.ai (snoop capture, 2026-11-13); custom providers pointing there get the rewrite too.
	for (const baseUrl of ["https://api.kimi.ai/coding/v1", "https://api.kimi.com/coding/v1"]) {
		it(`types enums for a custom provider on ${baseUrl}`, async () => {
			const model = { ...getModel("kimi-coding", "k3" as never), provider: "custom", baseUrl };
			const parameters = await sentParameters(model as Model<"openai-completions">);
			expect(parameters.properties.lane.type).toBe("string");
		});
	}

	it("sends schemas unchanged to other providers", async () => {
		const model = {
			...getModel("kimi-coding", "k3" as never),
			provider: "custom",
			baseUrl: "https://example.com/v1",
		};
		const parameters = await sentParameters(model as Model<"openai-completions">);
		expect(parameters).toEqual(JING_DELEGATE);
	});
});
