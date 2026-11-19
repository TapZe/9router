import { describe, it, expect } from "vitest";
import { captureFactoryCompatibility, applyExplicitFactoryToolChoice } from "../../open-sse/utils/factoryRequestCompatibility.js";
const formats = ["openai", "openai-responses", "claude", "gemini"];
const gateways = ["openai-completions", "openai-responses", "anthropic", "google"];
const native = (format, mode) => format === "gemini" ? { mode: { auto: "AUTO", none: "NONE", required: "ANY" }[mode] } : format === "claude" ? { type: mode === "required" ? "any" : mode } : mode;
const named = (format, name) => format === "gemini" ? { mode: "ANY", allowedFunctionNames: [name] } : format === "openai" ? { type: "function", function: { name } } : { type: format === "claude" ? "tool" : "function", name };
const context = (format, choice) => captureFactoryCompatibility(format, format === "gemini" ? { toolConfig: { functionCallingConfig: choice } } : { tool_choice: choice }, "Droid").context;

describe("Factory explicit choice preservation", () => {
  for (const source of formats) for (let i = 0; i < formats.length; i++) {
    const target = formats[i];
    const gateway = gateways[i];
    it(`${source} -> ${gateway} preserves all shared modes and named intent`, () => {
      const body = { tool_choice: "default", tools: [] };
      expect(applyExplicitFactoryToolChoice(body, gateway, context(source, undefined))).toBe(body);
      for (const mode of ["auto", "none", "required"]) {
        const result = applyExplicitFactoryToolChoice(body, gateway, context(source, native(source, mode)));
        expect(target === "gemini" ? result.toolConfig.functionCallingConfig : result.tool_choice).toEqual(native(target, mode));
        if (target === "gemini") expect(result).not.toHaveProperty("tool_choice");
      }
      const result = applyExplicitFactoryToolChoice(body, gateway, context(source, named(source, "read")));
      expect(target === "gemini" ? result.toolConfig.functionCallingConfig : result.tool_choice).toEqual(named(target, "inspect_file"));
    });
  }
  it("keeps native restrictions, ancillary fields and all allowed names", () => {
    const raw = { mode: "VALIDATED", allowedFunctionNames: ["read", "bash"], future: { signed: "opaque" } };
    const result = applyExplicitFactoryToolChoice({}, "google", context("gemini", raw));
    expect(result.toolConfig.functionCallingConfig).toEqual({ ...raw, allowedFunctionNames: ["inspect_file", "omp_bash"] });
    expect(raw.allowedFunctionNames).toEqual(["read", "bash"]);
    const claude = { type: "tool", name: "read", disable_parallel_tool_use: true };
    expect(applyExplicitFactoryToolChoice({}, "anthropic", context("claude", claude)).tool_choice).toEqual({ ...claude, name: "inspect_file" });
    const chat = { type: "function", function: { name: "read" }, future: true };
    expect(applyExplicitFactoryToolChoice({}, "openai-completions", context("openai", chat)).tool_choice).toEqual({ ...chat, function: { name: "inspect_file" } });
  });
  it.each([{ mode: "VALIDATED" }, { mode: "ANY", allowedFunctionNames: ["read", "bash"] }, { mode: "AUTO", future: true }])("rejects cross-format narrowing of %j", (raw) => {
    expect(() => applyExplicitFactoryToolChoice({}, "anthropic", context("gemini", raw))).toThrow("factory: cannot preserve explicit tool choice for gemini -> anthropic");
  });
  it("reads Gemini-family effective choice without discarding envelopes", () => {
    for (const format of ["gemini-cli", "antigravity"]) {
      const request = { toolConfig: { functionCallingConfig: { mode: "VALIDATED", allowedFunctionNames: ["read", "bash"] } } };
      const original = format === "antigravity" ? { project: "p", request } : { project: "p", ...request };
      const captured = captureFactoryCompatibility(format, original, "Droid");
      expect(captured.body).toBe(original);
      expect(applyExplicitFactoryToolChoice({}, "google", captured.context).toolConfig.functionCallingConfig.allowedFunctionNames).toEqual(["inspect_file", "omp_bash"]);
      expect(() => applyExplicitFactoryToolChoice({}, "openai-completions", captured.context)).toThrow("cannot preserve");
    }
  });
});

it("normalizes shared object forms even on matching transports", () => {
  expect(applyExplicitFactoryToolChoice({}, "openai-completions", context("openai", { type: "required" })).tool_choice).toBe("required");
  expect(applyExplicitFactoryToolChoice({}, "openai-responses", context("openai-responses", { type: "auto" })).tool_choice).toBe("auto");
  expect(applyExplicitFactoryToolChoice({}, "openai-completions", context("openai", { type: "tool", name: "read" })).tool_choice).toEqual({ type: "function", function: { name: "inspect_file" } });
  expect(applyExplicitFactoryToolChoice({}, "openai-responses", context("openai-responses", { type: "function", function: { name: "read" } })).tool_choice).toEqual({ type: "function", name: "inspect_file" });
});

it("keeps native-only custom choices and empty names upstream-owned on a matching format", () => {
  const custom = { type: "custom", name: "edit", future: "signed" };
  expect(applyExplicitFactoryToolChoice({}, "openai-responses", context("openai-responses", custom)).tool_choice).toEqual({ ...custom, name: "edit_file" });
  expect(() => applyExplicitFactoryToolChoice({}, "anthropic", context("openai-responses", custom))).toThrow("cannot preserve");
  expect(applyExplicitFactoryToolChoice({}, "openai-completions", context("openai", { type: "function", function: { name: "" } })).tool_choice).toEqual({ type: "function", function: { name: "" } });
});
