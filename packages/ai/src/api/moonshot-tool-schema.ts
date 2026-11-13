// Rewrites tool parameter schemas into the subset Moonshot's validator ("moonshot flavored json schema") accepts.
//
// Rules observed on https://api.kimi.com/coding/v1 (all kimi-coding models, 2026-11-13); each one otherwise fails
// the request with 400 invalid_request_error:
// - A schema with `enum` must declare `type` ("type is not defined"). MCP servers commonly send bare `{ enum: [...] }`.
// - With `enum`, a `type` array may only be `[<string|integer|number|boolean>, "null"]`.
// - `enum` must not be empty.
// - `items` must be one schema, not a tuple array ("items must be an object").
// Only these positions are checked: properties, items, additionalProperties, anyOf, $defs/definitions. Untyped
// `const`, empty schemas, `oneOf`, `allOf`, `$ref` and object schemas without `properties` pass as they are.

type JsonSchema = Record<string, unknown>;

/** Returns `schema` in Moonshot's accepted subset, copying only the nodes it changes; the input is never mutated. */
export function toMoonshotToolSchema(schema: unknown): unknown {
	if (!isSchema(schema)) return schema;
	let out: JsonSchema | undefined;
	const set = (key: string, value: unknown) => {
		if (schema[key] === value) return;
		out ??= { ...schema };
		out[key] = value;
	};

	for (const key of SCHEMA_KEYWORDS) {
		if (key in schema) set(key, toMoonshotToolSchema(schema[key]));
	}
	for (const key of SCHEMA_LIST_KEYWORDS) {
		const list = schema[key];
		if (Array.isArray(list)) set(key, mapList(list));
	}
	for (const key of SCHEMA_MAP_KEYWORDS) {
		const map = schema[key];
		if (isSchema(map)) set(key, mapRecord(map));
	}
	// Draft-07 tuple `items: [...]` is draft 2020-12 `prefixItems`; Moonshot accepts only the latter.
	const items = (out ?? schema).items;
	if (Array.isArray(items)) {
		out ??= { ...schema };
		out.prefixItems = mapList(items);
		if ("additionalItems" in out) out.items = out.additionalItems;
		else delete out.items;
		delete out.additionalItems;
	}

	const enumFix = typeEnum(out ?? schema);
	return enumFix ?? out ?? schema;
}

const SCHEMA_KEYWORDS = [
	"items",
	"additionalItems",
	"additionalProperties",
	"unevaluatedItems",
	"unevaluatedProperties",
	"contains",
	"propertyNames",
	"not",
	"if",
	"then",
	"else",
];
const SCHEMA_LIST_KEYWORDS = ["anyOf", "oneOf", "allOf", "prefixItems"];
const SCHEMA_MAP_KEYWORDS = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"];

function isSchema(value: unknown): value is JsonSchema {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapList(list: unknown[]): unknown[] {
	const mapped = list.map(toMoonshotToolSchema);
	return mapped.every((value, index) => value === list[index]) ? list : mapped;
}

function mapRecord(record: JsonSchema): JsonSchema {
	let out: JsonSchema | undefined;
	for (const [key, value] of Object.entries(record)) {
		const mapped = toMoonshotToolSchema(value);
		if (mapped === value) continue;
		out ??= { ...record };
		out[key] = mapped;
	}
	return out ?? record;
}

const PRIMITIVE_TYPES = new Set(["string", "integer", "number", "boolean"]);

/** Gives an `enum` schema the `type` Moonshot requires, from its values; undefined when nothing needs to change. */
function typeEnum(schema: JsonSchema): JsonSchema | undefined {
	const values = schema.enum;
	if (!Array.isArray(values)) return undefined;
	if (values.length === 0) {
		// An empty enum admits no value; `not: {}` says the same in a form Moonshot accepts.
		const { enum: _empty, ...withoutEnum } = schema;
		return { ...withoutEnum, not: {} };
	}
	const { type } = schema;
	if (typeof type === "string") return undefined;
	if (Array.isArray(type) && isAcceptedEnumTypeArray(type)) return undefined;

	const groups = new Map<string, unknown[]>();
	for (const value of values) {
		const valueType = jsonType(value);
		groups.set(valueType, [...(groups.get(valueType) ?? []), value]);
	}
	// JSON Schema "number" covers integers, so mixed integer and number values share one branch.
	const integers = groups.get("integer");
	if (integers && groups.has("number")) {
		groups.get("number")?.push(...integers);
		groups.delete("integer");
	}
	const hasNull = groups.delete("null");
	const types = [...groups.keys()];

	const { enum: _enum, type: _type, ...rest } = schema;
	if (types.length === 0) return { ...rest, type: "null" };
	if (types.length === 1 && !hasNull) return { ...rest, type: types[0], enum: values };
	if (types.length === 1 && PRIMITIVE_TYPES.has(types[0])) return { ...rest, type: [types[0], "null"], enum: values };

	// Several value types: one typed enum per type, joined by anyOf (kept beside any anyOf the schema already has).
	const branches: JsonSchema[] = [...groups].map(([branchType, branchValues]) => ({
		type: branchType,
		enum: branchValues,
	}));
	if (hasNull) branches.push({ type: "null" });
	if (rest.anyOf === undefined) return { ...rest, anyOf: branches };
	const allOf = Array.isArray(rest.allOf) ? rest.allOf : [];
	return { ...rest, allOf: [...allOf, { anyOf: branches }] };
}

function isAcceptedEnumTypeArray(type: unknown[]): boolean {
	if (type.length === 1) return typeof type[0] === "string";
	return (
		type.length === 2 && type.includes("null") && type.some((t) => typeof t === "string" && PRIMITIVE_TYPES.has(t))
	);
}

function jsonType(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
	return typeof value;
}
