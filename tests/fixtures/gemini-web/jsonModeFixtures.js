// Shared response_format fixtures for the Gemini Web JSON mode suites.

export const PERSON_SCHEMA = Object.freeze({
  type: "object",
  properties: { name: { type: "string" }, age: { type: "integer" } },
  required: ["name", "age"],
});

export const PERSON_JSON = '{"name":"Ada","age":36}';
