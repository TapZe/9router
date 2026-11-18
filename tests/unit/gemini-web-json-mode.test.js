// Gemini Web response_format (JSON mode): parsing the request field, the
// prompts, and checking a reply. Ported from gemini-web-to-api
// (internal/modules/openai/openai_json_mode_test.go). Pure functions only.

import { describe, expect, it } from "vitest";

import {
  buildJSONModePrompt,
  extractJSONReply,
  parseResponseFormat,
  repairJSONPrompt,
  validateJSONReply,
} from "../../open-sse/executors/gemini-web/jsonMode.js";

const PERSON_SCHEMA = {
  type: "object",
  properties: { name: { type: "string" }, age: { type: "integer" } },
  required: ["name", "age"],
};
const PERSON_JSON = '{"name":"Ada","age":36}';
const OBJECT_MODE = { schema: null };
const PERSON_MODE = { schema: PERSON_SCHEMA };

describe("Gemini Web response_format parsing", () => {
  it("turns JSON mode on only for json_object and json_schema", () => {
    expect(parseResponseFormat({ response_format: { type: "json_object" } })).toEqual({ schema: null });
    expect(parseResponseFormat({ response_format: { type: " JSON_Object " } })).toEqual({ schema: null });
    expect(
      parseResponseFormat({ response_format: { type: "json_schema", json_schema: { name: "p", schema: PERSON_SCHEMA } } })
    ).toEqual({ schema: PERSON_SCHEMA });
    for (const body of [
      {},
      null,
      { response_format: null },
      { response_format: "json_object" },
      { response_format: { type: "text" } },
      { response_format: { type: "xml" } },
      { response_format: {} },
    ]) {
      expect(parseResponseFormat(body)).toBeNull();
    }
  });

  it("reads a json_schema block that already is the schema, and no block as no schema", () => {
    const format = (json_schema) => parseResponseFormat({ response_format: { type: "json_schema", json_schema } });
    expect(format({ type: "array" })).toEqual({ schema: { type: "array" } });
    expect(format({ name: "p", schema: null })).toEqual({ schema: { name: "p", schema: null } });
    expect(format(undefined)).toEqual({ schema: null });
    expect(format(null)).toEqual({ schema: null });
  });
});

describe("Gemini Web JSON mode prompts", () => {
  const base = "Invent a person.";

  it("asks for a single JSON object without suggesting a shape", () => {
    expect(buildJSONModePrompt(base, OBJECT_MODE)).toBe(
      "You are an OpenAI-compatible assistant running behind a bridge to Gemini web.\n" +
        "Respond with JSON only. Do not use markdown code fences and do not write any text outside the JSON.\n" +
        "The reply must be a single JSON object, with the fields the conversation asks for.\n" +
        "\nConversation:\nInvent a person."
    );
  });

  it("carries the schema and asks for every required property", () => {
    expect(buildJSONModePrompt(base, PERSON_MODE)).toBe(
      "You are an OpenAI-compatible assistant running behind a bridge to Gemini web.\n" +
        "Respond with JSON only. Do not use markdown code fences and do not write any text outside the JSON.\n" +
        "The reply must be a single JSON value that matches this JSON Schema:\n" +
        `${JSON.stringify(PERSON_SCHEMA)}\nSet every required property.\n` +
        "\nConversation:\nInvent a person."
    );
  });

  it("repairs with the reason and the shape", () => {
    expect(repairJSONPrompt("P", OBJECT_MODE, "the reply is not valid JSON")).toBe(
      "P\n\nYour previous reply could not be used: the reply is not valid JSON. Reply again with JSON only, " +
        "with no markdown code fences and no text outside the JSON, as a single JSON object."
    );
    expect(repairJSONPrompt("P", PERSON_MODE, "why")).toBe(
      "P\n\nYour previous reply could not be used: why. Reply again with JSON only, with no markdown code " +
        `fences and no text outside the JSON, matching this JSON Schema: ${JSON.stringify(PERSON_SCHEMA)}.`
    );
  });
});

describe("Gemini Web JSON reply extraction", () => {
  it.each([
    ["bare object", PERSON_JSON, PERSON_JSON],
    ["json fence", "```json\n" + PERSON_JSON + "\n```", PERSON_JSON],
    ["unlabelled fence", "```\n" + PERSON_JSON + "\n```", PERSON_JSON],
    ["prose around the object", "Here is the person:\n" + PERSON_JSON + "\nHope it helps.", PERSON_JSON],
    ["prose with braces before the object", "Picking {name, age}:\n" + PERSON_JSON, PERSON_JSON],
    ["fenced object with prose around the fence", "Sure.\n```json\n" + PERSON_JSON + "\n```\nDone.", PERSON_JSON],
    ["raw newline inside a string", '{"name":"Ada\nLovelace","age":36}', '{"name":"Ada\\nLovelace","age":36}'],
    ["raw tab and return inside a string", '{"a":"x\ty\rz"}', '{"a":"x\\ty\\rz"}'],
    ["other control character inside a string", '{"a":"x\u0001"}', '{"a":"x\\u0001"}'],
    [
      "raw newline next to a nested object repairs the whole reply",
      '{"name":"Ada","meta":{"a":1},"bio":"line1\nline2"}',
      '{"name":"Ada","meta":{"a":1},"bio":"line1\\nline2"}',
    ],
    ["a whole JSON value that is not an object", ' [1, 2] ', "[1, 2]"],
    ["broken object never yields a nested one", '{"person":{"name":"Ada","age":36},}', null],
    ["truncated object never yields a nested one", '{"person":{"name":"Ada","age":36},"bio":"Mathem', null],
    ["not JSON", "The answer is 42.", null],
    ["truncated object", '{"name":"Ada"', null],
    ["empty", "   ", null],
  ])("%s", (_name, reply, expected) => {
    expect(extractJSONReply(reply)).toBe(expected);
  });
});

describe("Gemini Web JSON reply check", () => {
  const ok = (json) => ({ json, error: null });
  const fail = (error) => ({ json: null, error });

  it.each([
    ["json_object accepts an object", PERSON_JSON, OBJECT_MODE, ok(PERSON_JSON)],
    ["json_object accepts a fenced object", "```json\n" + PERSON_JSON + "\n```", OBJECT_MODE, ok(PERSON_JSON)],
    ["json_object accepts a prose-wrapped object", "Here: " + PERSON_JSON, OBJECT_MODE, ok(PERSON_JSON)],
    ["json_object rejects an array", '[{"name":"Ada"}]', OBJECT_MODE, fail("the reply is a JSON array, not a JSON object")],
    ["json_object rejects a string", '"Ada"', OBJECT_MODE, fail("the reply is a JSON string, not a JSON object")],
    ["json_object rejects prose", "The answer is 42.", OBJECT_MODE, fail("the reply is not valid JSON")],
    ["json_schema accepts the required keys", PERSON_JSON, PERSON_MODE, ok(PERSON_JSON)],
    ["json_schema rejects a missing required key", '{"name":"Ada"}', PERSON_MODE, fail('the reply is missing required key "age"')],
    ["json_schema rejects the wrong top-level type", '["Ada"]', PERSON_MODE, fail("the reply is a JSON array, want object")],
    [
      "json_schema accepts an array when it asks for one",
      '[{"name":"Ada","age":36}]',
      { schema: { type: "array", items: { type: "object" } } },
      ok('[{"name":"Ada","age":36}]'),
    ],
    ["an integer satisfies number", "36", { schema: { type: "number" } }, ok("36")],
    ["a number does not satisfy integer", "36.5", { schema: { type: "Integer " } }, fail("the reply is a JSON number, want integer")],
    ["an exponent is a number", "1e3", { schema: { type: "integer" } }, fail("the reply is a JSON number, want integer")],
    ["true is a boolean", "true", { schema: { type: "null" } }, fail("the reply is a JSON boolean, want null")],
    ["null is null", "null", { schema: { type: "boolean" } }, fail("the reply is a JSON null, want boolean")],
    ["unreadable schema only needs valid JSON", '["anything"]', { schema: "not a schema" }, ok('["anything"]')],
    ["a type list is not checked", '["x"]', { schema: { type: ["object", "null"] } }, ok('["x"]')],
    ["a required list it cannot read is not checked", '{"a":1}', { schema: { required: "a" } }, ok('{"a":1}')],
    ["required keys need an object", '["x"]', { schema: { required: ["a", "b"] } }, fail("the reply is a JSON array, want a JSON object with a, b")],
    ["required keys without a type", '{"a":1}', { schema: { required: ["a"] } }, ok('{"a":1}')],
    ["invalid JSON fails before the schema is checked", "no json here", PERSON_MODE, fail("the reply is not valid JSON")],
  ])("%s", (_name, reply, jsonMode, expected) => {
    expect(validateJSONReply(reply, jsonMode)).toEqual(expected);
  });
});
