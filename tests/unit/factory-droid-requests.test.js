import { describe, expect, it } from "vitest";
import { FactoryExecutor } from "../../open-sse/executors/factory.js";
import { FACTORY_DROID_MODELS } from "../../open-sse/providers/factoryDroid.js";
import { FACTORY_DROID_REQUESTS } from "../../open-sse/providers/factoryDroidRequests.js";

// Fields Droid 1.3.0 decides per model, effort, and provider. The request
// sends Droid's value for each, or leaves it out when Droid does.
const DROID_OWNED_FIELDS = {
  anthropic: ["thinking", "output_config.effort", "speed", "context_management"],
  responses: [
    "reasoning", "include", "parallel_tool_calls", "prompt_cache_retention", "text.verbosity",
    "service_tier", "safety_identifier", "max_output_tokens", "tool_choice",
  ],
  completions: [
    "reasoning_effort", "reasoning_history", "chat_template_args", "chat_template_kwargs.enable_thinking",
    "enable_thinking", "allow_missing_thinking", "thinking", "reasoning", "temperature", "store", "tool_choice",
  ],
  google: [
    "generationConfig.thinkingConfig", "generationConfig.temperature", "generationConfig.topP",
    "generationConfig.topK", "generationConfig.maxOutputTokens",
  ],
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const at = (body, path) => path.split(".").reduce((value, key) => value?.[key], body);
const credentialsFor = (region) => ({ accessToken: "tok", providerSpecificData: { inferenceRegion: region } });
const tools = [{ type: "function", function: { name: "read", description: "Read", parameters: { type: "object" } } }];

// A client body that asks for one effort, with the client's own values in
// fields Droid owns so the test sees them replaced.
function clientBody(api, effort) {
  if (api === "anthropic") {
    return {
      messages: [{ role: "user", content: "hi" }], max_tokens: 64000, tools, speed: "slow",
      ...(effort === "none" ? { thinking: { type: "disabled" } } : { output_config: { effort } }),
    };
  }
  if (api === "responses") {
    return { input: [{ role: "user", content: "hi" }], tools, reasoning: { effort }, service_tier: "flex", text: { verbosity: "high" } };
  }
  if (api === "google") {
    return { contents: [{ role: "user", parts: [{ text: "hi" }] }], reasoning_effort: effort, temperature: 0.2, max_tokens: 100 };
  }
  return { messages: [{ role: "user", content: "hi" }], tools, reasoning_effort: effort, temperature: 0.2, max_completion_tokens: 100, enable_thinking: true };
}

function send(model, region, body) {
  const executor = new FactoryExecutor();
  const credentials = credentialsFor(region);
  const sent = executor.transformRequest(model, body, true, credentials);
  const headers = executor.buildHeaders(credentials, true, "", model, sent);
  return { sent, headers };
}

describe("Factory request fields from Droid 1.3.0", () => {
  it("sends Droid's body and betas for every model, provider, and effort", () => {
    for (const [model, droid] of Object.entries(FACTORY_DROID_MODELS)) {
      for (const [region, provider] of Object.entries(droid.providers)) {
        for (const effort of droid.efforts) {
          const request = FACTORY_DROID_REQUESTS[model][provider][effort];
          const label = `${model} ${region} ${effort}`;
          const { sent, headers } = send(model, region, clientBody(droid.api, effort));
          for (const path of DROID_OWNED_FIELDS[droid.api]) {
            const expected = at(request.body, path);
            if (expected === "$session") expect(at(sent, path), `${label} ${path}`).toMatch(UUID);
            else expect(at(sent, path), `${label} ${path}`).toEqual(expected);
          }
          if (droid.api === "anthropic") {
            const toolStreaming = ["anthropic", "vertex_anthropic"].includes(provider) ? ["fine-grained-tool-streaming-2025-05-14"] : [];
            const betas = [...(request.betas ?? []), ...toolStreaming];
            expect(headers["anthropic-beta"], label).toBe(betas.length ? betas.join(",") : undefined);
          }
          if (droid.api === "completions") {
            expect(sent.max_tokens, label).toBe(100);
            expect(sent.max_completion_tokens, label).toBeUndefined();
          }
        }
      }
    }
  });

  it("matches request bodies read from the Droid 1.3.0 binary", () => {
    expect(send("gpt-5.5-fast", "global", clientBody("responses", "high")).sent).toMatchObject({
      tool_choice: "auto", parallel_tool_calls: true, include: ["reasoning.encrypted_content"],
      reasoning: { effort: "high", summary: "auto" }, prompt_cache_retention: "24h",
      text: { verbosity: "low" }, service_tier: "priority",
    });
    const opusFast = send("claude-opus-4-8-fast", "global", clientBody("anthropic", "high"));
    expect(opusFast.sent).toMatchObject({ speed: "fast", output_config: { effort: "high" } });
    expect(opusFast.headers["anthropic-beta"]).toBe("fast-mode-2026-02-01,fine-grained-tool-streaming-2025-05-14");
    expect(send("claude-sonnet-5-5", "global", clientBody("anthropic", "none")).sent).toMatchObject({
      thinking: { type: "between_tools" }, output_config: { effort: "high" },
    });
    expect(send("claude-sonnet-4-5-20250929", "global", clientBody("anthropic", "low")).sent.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
    expect(send("glm-5.1", "us", clientBody("completions", "high")).sent).toMatchObject({ temperature: 1, chat_template_args: { enable_thinking: true } });
    expect(send("beam-1.0", "global", clientBody("completions", "high")).sent).toMatchObject({ reasoning_effort: "high", allow_missing_thinking: true });
    expect(send("gemini-3-pro-preview", "global", clientBody("google", "medium")).sent.generationConfig).toEqual({
      temperature: 1, topP: 0.95, topK: 64, thinkingConfig: { includeThoughts: true, thinkingLevel: "HIGH" },
    });
    expect(send("grok-4.7", "global", clientBody("responses", "low")).sent.max_output_tokens).toBe(63356);
  });

  it("sends the default effort's body when the client names no effort", () => {
    const { sent } = send("kimi-k3", "global", { messages: [{ role: "user", content: "hi" }] });
    expect(sent).toMatchObject({ temperature: 1, reasoning_effort: "high", reasoning_history: "preserved" });
  });

  it("uses one session id for safety_identifier and x-session-id", () => {
    const { sent, headers } = send("gpt-5.5", "global", clientBody("responses", "high"));
    expect(sent.safety_identifier).toMatch(UUID);
    expect(headers["x-session-id"]).toBe(sent.safety_identifier);
  });

  it("leaves models Droid no longer lists on the old path", () => {
    const { sent } = send("gpt-5.1", "global", { input: [{ role: "user", content: "hi" }], reasoning_effort: "high", temperature: 0.2 });
    expect(sent.reasoning).toEqual({ effort: "high" });
    expect(sent.temperature).toBeUndefined();
    expect(sent.prompt_cache_retention).toBeUndefined();
  });
});
