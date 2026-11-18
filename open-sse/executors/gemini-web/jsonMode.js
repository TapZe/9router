// JSON mode (OpenAI response_format) for the Gemini Web executor.
//
// Gemini Web has no JSON mode of its own. This is best-effort: the reply shape
// is asked for in the prompt, the reply is checked afterwards, and at most one
// repair turn is spent on it. Ported from gemini-web-to-api
// (internal/modules/openai/openai_json_mode.go, #110). MIT.
//
// A JSON mode is `{ schema }`: `schema` is the JSON Schema of json_schema, or
// null for json_object. No JSON mode is null.

import { balancedObjectAt, escapeStringControlChars, isObject, text } from "./jsonText.js";

/** The JSON Schema in a json_schema block: OpenAI nests it under "schema". */
function schemaDocument(block) {
  if (isObject(block) && block.schema !== undefined && block.schema !== null) return block.schema;
  return block ?? null;
}

/**
 * Parse `response_format` once, where it enters the executor. Only json_object
 * and json_schema turn JSON mode on; "text", unknown types and a missing field
 * are ignored, so clients that send them keep working.
 */
export function parseResponseFormat(body) {
  const format = body?.response_format;
  if (!isObject(format)) return null;
  const type = text(format.type).toLowerCase();
  if (type === "json_object") return { schema: null };
  if (type === "json_schema") return { schema: schemaDocument(format.json_schema) };
  return null;
}

/** Wrap the flattened conversation in the JSON-mode instructions. */
export function buildJSONModePrompt(basePrompt, jsonMode) {
  const lines = [
    "You are an OpenAI-compatible assistant running behind a bridge to Gemini web.",
    "Respond with JSON only. Do not use markdown code fences and do not write any text outside the JSON.",
  ];
  if (jsonMode.schema !== null) {
    lines.push("The reply must be a single JSON value that matches this JSON Schema:");
    lines.push(JSON.stringify(jsonMode.schema), "Set every required property.");
  } else {
    lines.push("The reply must be a single JSON object, with the fields the conversation asks for.");
  }
  return `${lines.join("\n")}\n\nConversation:\n${basePrompt}`;
}

/** The same prompt again, saying what was wrong with the reply. Sent at most once. */
export function repairJSONPrompt(prompt, jsonMode, reason) {
  const shape =
    jsonMode.schema !== null
      ? `, matching this JSON Schema: ${JSON.stringify(jsonMode.schema)}`
      : ", as a single JSON object";
  return (
    `${prompt}\n\nYour previous reply could not be used: ${reason}. ` +
    `Reply again with JSON only, with no markdown code fences and no text outside the JSON${shape}.`
  );
}

/** A reply in a markdown code fence, without the fence. */
function stripCodeFence(value) {
  if (!value.startsWith("```")) return value;
  const inner = value.slice(3).replace(/^(json|JSON)/, "").trim();
  const end = inner.lastIndexOf("```");
  return end >= 0 ? inner.slice(0, end).trim() : inner;
}

function parses(doc) {
  try {
    JSON.parse(doc);
    return true;
  } catch {
    return false;
  }
}

/** `doc` when it is JSON, its escaped form when only raw control characters break it, else null. */
function validJSON(doc) {
  if (parses(doc)) return doc;
  const escaped = escapeStringControlChars(doc);
  return parses(escaped) ? escaped : null;
}

/**
 * The first top-level `{...}` in `form` that is JSON. Nested objects are never
 * tried, so a reply that is broken as a whole never yields one of its parts.
 */
function topLevelObject(form) {
  let rest = form;
  for (let start = rest.indexOf("{"); start >= 0; start = rest.indexOf("{")) {
    const candidate = balancedObjectAt(rest, start);
    // An object that never closes holds everything after it.
    if (!candidate) return null;
    const doc = validJSON(candidate);
    if (doc) return doc;
    rest = rest.slice(start + candidate.length);
  }
  return null;
}

/**
 * The JSON document in a reply, without a code fence or prose around it, or
 * null. The whole reply, with and then without its fence, is tried before any
 * object inside it. The fence needs no second object scan: the objects inside
 * it are found in the whole reply too.
 */
export function extractJSONReply(reply) {
  const trimmed = reply.trim();
  return validJSON(trimmed) || validJSON(stripCodeFence(trimmed)) || topLevelObject(trimmed);
}

/** object, array, string, number, integer, boolean or null. */
function jsonTypeOf(doc) {
  const value = JSON.parse(doc);
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return /[.eE]/.test(doc) ? "number" : "integer";
  return typeof value;
}

/** An integer also satisfies "number", never the other way round. */
function typeMatches(want, actual) {
  return want === actual || (want === "number" && actual === "integer");
}

function isKeyList(value) {
  return Array.isArray(value) && value.every((key) => typeof key === "string");
}

/**
 * The part of a schema that is checked, or null when it cannot be read. A
 * schema that is not an object has no type or required keys to check.
 */
function schemaShape(schema) {
  const { type = "", required = [] } = schema;
  if (type !== null && typeof type !== "string") return null;
  if (required !== null && !isKeyList(required)) return null;
  return { type: text(type).toLowerCase(), required: required || [] };
}

function shapeError(doc, actual, shape) {
  if (shape.type && !typeMatches(shape.type, actual)) return `the reply is a JSON ${actual}, want ${shape.type}`;
  if (shape.required.length === 0) return null;
  const value = JSON.parse(doc);
  if (!isObject(value)) return `the reply is a JSON ${actual}, want a JSON object with ${shape.required.join(", ")}`;
  const missing = shape.required.find((key) => !Object.hasOwn(value, key));
  return missing === undefined ? null : `the reply is missing required key "${missing}"`;
}

/**
 * Check a reply against the JSON mode. json_object needs a JSON object;
 * json_schema needs the schema's top-level type and required keys, nothing
 * deeper. A schema that cannot be read only needs valid JSON.
 *
 * @returns {{ json: string|null, error: string|null }} the cleaned JSON, or why it is unusable
 */
export function validateJSONReply(reply, jsonMode) {
  const doc = extractJSONReply(reply);
  if (doc === null) return { json: null, error: "the reply is not valid JSON" };
  const actual = jsonTypeOf(doc);
  let error = null;
  if (jsonMode.schema === null) {
    if (actual !== "object") error = `the reply is a JSON ${actual}, not a JSON object`;
  } else {
    const shape = schemaShape(jsonMode.schema);
    if (shape) error = shapeError(doc, actual, shape);
  }
  return error ? { json: null, error } : { json: doc, error: null };
}
