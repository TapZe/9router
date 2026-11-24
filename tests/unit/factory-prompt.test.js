import { describe, it, expect } from "vitest";
import { captureFactoryCompatibility, prepareFactoryPromptBlocks, preserveFactoryResponsesPrompt } from "../../open-sse/utils/factoryRequestCompatibility.js";
import { OMP_GREETING_PREAMBLE as greeting } from "../../open-sse/config/factoryCompatibility.js";
const droid = "You are Droid.\nFull canonical prompt.";

describe("Factory exact prompt preparation", () => {
  it("strips only the main exact greeting and preserves metadata and subsequent blocks", () => {
    const blocks = [{ type: "text", text: droid, cache_control: { type: "ephemeral" } }, { type: "text", text: `${greeting}  Rules.\n`, stamp: "signed" }, { text: greeting }, { opaque: { name: "read" } }];
    const before = JSON.stringify(blocks);
    const result = prepareFactoryPromptBlocks(blocks, droid);
    expect(result).toEqual([blocks[0], { ...blocks[1], text: "  Rules.\n" }, blocks[2], blocks[3]]);
    expect(result[0]).toBe(blocks[0]);
    expect(result[3]).toBe(blocks[3]);
    expect(JSON.stringify(blocks)).toBe(before);
    expect(prepareFactoryPromptBlocks(result, droid, { stripGreeting: false })).toBe(result);
  });
  it.each(["You are omp's trusted coding assistant.\nRules", "You are omp's trusted coding assistant.\r\n\r\nRules", `Quoted: ${greeting}`, `Unknown.\n\n${greeting}`, `Quoted ${droid}`])("does not strip unfamiliar text %s", (text) => {
    expect(prepareFactoryPromptBlocks([text, greeting], droid)).toEqual([droid, text, greeting]);
  });
  it("recognizes only its own flattened prefix and drops an exhausted greeting block", () => {
    expect(prepareFactoryPromptBlocks([`${droid}\n\n${greeting}Rules.\n`], droid)).toEqual([droid, "Rules.\n"]);
    expect(prepareFactoryPromptBlocks(["", greeting, "Later."], droid)).toEqual([droid, "", "Later."]);
    expect(prepareFactoryPromptBlocks([`${droid}\n\nRules.\n`], droid)).toEqual([droid, "Rules.\n"]);
  });
  it.each(["openai", "openai-responses"])("uses original ordered %s source boundaries", (format) => {
    const key = format === "openai" ? "messages" : "input";
    const original = { [key]: [{ role: "system", content: [{ text: "" }, { text: droid }] }, { role: "developer", content: [{ text: `${greeting}Rules.\n`, cache_control: { type: "ephemeral" } }, { text: greeting }] }, { role: "user", content: greeting }] };
    const before = JSON.stringify(original);
    const result = captureFactoryCompatibility(format, original, droid);
    expect(result.body[key][1].content[0].text).toBe("Rules.\n");
    expect(result.body[key][1].content[1].text).toBe(greeting);
    expect(result.body[key][2]).toBe(original[key][2]);
    expect(JSON.stringify(original)).toBe(before);
    const unfamiliar = { [key]: [{ role: "system", content: "Unknown." }, { role: "developer", content: greeting }] };
    expect(captureFactoryCompatibility(format, unfamiliar, droid).body).toBe(unfamiliar);
  });
  it("captures Claude, Responses and Gemini family prompts without touching envelopes", () => {
    const fixtures = [
      ["claude", { system: [{ text: `${greeting}Rules.\n`, cache_control: { type: "ephemeral" } }] }, (b) => b.system[0].text],
      ["openai-responses", { instructions: `${greeting}Rules.\n`, input: [{ role: "system", content: greeting }] }, (b) => b.instructions],
      ["gemini", { systemInstruction: { parts: [{ text: `${greeting}Rules.\n` }] } }, (b) => b.systemInstruction.parts[0].text],
      ["gemini-cli", { systemInstruction: `${greeting}Rules.\n`, project: "test" }, (b) => b.systemInstruction],
      ["antigravity", { request: { systemInstruction: `${greeting}Rules.\n` }, project: "test" }, (b) => b.request.systemInstruction],
    ];
    for (const [format, original, prompt] of fixtures) {
      const before = JSON.stringify(original);
      const result = captureFactoryCompatibility(format, original, droid);
      expect(prompt(result.body)).toBe("Rules.\n");
      expect(JSON.stringify(original)).toBe(before);
      expect(result.context.promptPrepared).toBe(true);
    }
  });
  it("adapts only the cooperation sentence in the original OMP subagent system block", () => {
    const sentence = "You are operating on a piece of work assigned to you by the main agent.";
    const child = `⁂ Role\nBuild a test.\n⁂ Coop\n${sentence}\nKeep the remaining instructions.\n⁂ Completion\nReport the result.\n`;
    const expected = child.replace("You are operating", "You are working");
    const fixtures = [
      ["openai", { messages: [{ role: "system", content: "Parent rules." }, { role: "developer", content: child }, { role: "user", content: child }] }, (b) => b.messages[1].content],
      ["openai-responses", { instructions: child }, (b) => b.instructions],
      ["claude", { system: [{ text: "Parent rules." }, { text: child, cache_control: { type: "ephemeral" } }] }, (b) => b.system[1].text],
      ["gemini", { systemInstruction: { parts: [{ text: child }] } }, (b) => b.systemInstruction.parts[0].text],
    ];
    for (const [format, original, prompt] of fixtures) {
      const captured = captureFactoryCompatibility(format, original, droid).body;
      expect(prompt(captured), format).toBe(expected);
      expect(prompt(original), format).toBe(child);
      expect(captureFactoryCompatibility(format, captured, droid).body).toEqual(captured);
    }
    const quoted = { messages: [{ role: "system", content: `Example:\n${child}` }, { role: "user", content: child }] };
    expect(captureFactoryCompatibility("openai", quoted, droid).body).toBe(quoted);
    expect(captureFactoryCompatibility("openai", fixtures[0][1], droid).body.messages[2].content).toBe(child);
  });
});

it("does not guess prompt or tool schemas for opaque source formats", () => {
  const original = { messages: [{ role: "system", content: greeting + "opaque" }], tools: [{ name: "read" }], request: { systemInstruction: greeting + "opaque" } };
  const captured = captureFactoryCompatibility("opaque-provider", original, droid);
  expect(captured.body).toBe(original);
  expect([...captured.context.sourceToolNames]).toEqual([]);
});

it("restores only matching Responses prompt text, without replacing translator additions", () => {
  const source = { messages: [{ role: "system", content: "  Main rules.\n" }, { role: "developer", content: "Later rules.\n" }] };
  expect(preserveFactoryResponsesPrompt("openai", source, { instructions: "Main rules.\n\nLater rules." }).instructions).toBe("  Main rules.\n\n\nLater rules.\n");
  const changed = { instructions: "Translator-owned additions.\n\nMain rules." };
  expect(preserveFactoryResponsesPrompt("openai", source, changed)).toBe(changed);
});
