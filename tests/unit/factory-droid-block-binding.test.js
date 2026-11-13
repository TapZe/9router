import { describe, expect, it } from "vitest";
import { FactoryExecutor } from "../../open-sse/executors/factory.js";

// Droid 1.10.0 sends thinking.block_binding and its beta on the direct
// anthropic provider too, not only on azure. Values read from the binary's
// Anthropic builder with an offline probe.
const BINDING = { prefix_mismatch_behavior: "drop_block" };
const BETA = "thinking-binding-controls-2026-08-01";
const TOOL_STREAMING = "fine-grained-tool-streaming-2025-05-14";
const tools = [{ type: "function", function: { name: "read", description: "Read", parameters: { type: "object" } } }];

function send(model, region, extra) {
  const executor = new FactoryExecutor();
  const credentials = { accessToken: "tok", providerSpecificData: { inferenceRegion: region } };
  const body = { messages: [{ role: "user", content: "hi" }], max_tokens: 64000, tools, ...extra };
  const sent = executor.transformRequest(model, body, true, credentials);
  return { sent, headers: executor.buildHeaders(credentials, true, "", model, sent) };
}

describe("Factory Anthropic thinking block binding from Droid 1.10.0", () => {
  it("binds thinking blocks on anthropic for the 5.5 family and Fable 5.1", () => {
    for (const model of ["claude-fable-5.1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]) {
      const { sent, headers } = send(model, "global", { output_config: { effort: "high" } });
      expect(sent.thinking, model).toEqual({ type: "adaptive", display: "summarized", block_binding: BINDING });
      expect(headers["anthropic-beta"], model).toBe(`${BETA},${TOOL_STREAMING}`);
    }
  });

  it("puts the binding beta before fast mode on Opus 5.5 Fast", () => {
    const { sent, headers } = send("claude-opus-5-5-fast", "global", { output_config: { effort: "max" } });
    expect(sent).toMatchObject({ speed: "fast", thinking: { block_binding: BINDING } });
    expect(headers["anthropic-beta"]).toBe(`${BETA},fast-mode-2026-02-01,${TOOL_STREAMING}`);
  });

  it("binds Fable 5.1 with thinking off, but not Sonnet or Haiku 5.5 off", () => {
    const off = { thinking: { type: "disabled" } };
    expect(send("claude-fable-5.1", "global", off).sent.thinking).toEqual({ type: "adaptive", display: "summarized", block_binding: BINDING });
    expect(send("claude-sonnet-5-5", "global", off).sent.thinking).toEqual({ type: "between_tools" });
    expect(send("claude-haiku-5-5", "global", off).sent.thinking).toEqual({ type: "disabled" });
    expect(send("claude-haiku-5-5", "global", off).headers["anthropic-beta"]).toBe(TOOL_STREAMING);
  });

  it("leaves vertex_anthropic in eu and older models as they were", () => {
    const eu = send("claude-fable-5.1", "eu", { output_config: { effort: "high" } });
    expect(eu.sent.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(eu.headers["anthropic-beta"]).toBe(`effort-2025-11-24,${TOOL_STREAMING}`);
    const opus5 = send("claude-opus-5", "global", { output_config: { effort: "high" } });
    expect(opus5.sent.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(opus5.headers["anthropic-beta"]).toBe(TOOL_STREAMING);
  });
});
