import { describe, expect, it, vi } from "vitest";
import { FactoryExecutor } from "../../open-sse/executors/factory.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import factoryRegistry from "../../open-sse/providers/registry/factory.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";

// No request in this file may reach Factory. The mock records what would be sent.
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })),
}));

const region = (inferenceRegion) => ({ accessToken: "tok", providerSpecificData: { inferenceRegion } });
const hi = [{ role: "user", content: "hi" }];

// Sends an OpenAI client request through the translator and the executor and
// returns what would go to Factory.
async function send(model, body, credentials = { accessToken: "tok" }) {
  proxyAwareFetch.mockClear();
  const { targetFormat } = factoryRegistry.models.find(({ id }) => id === model);
  const translated = translateRequest("openai", targetFormat, model, { model, ...body }, true, null, "factory");
  const { response } = await new FactoryExecutor().execute({ model, body: translated, stream: true, credentials });
  const call = proxyAwareFetch.mock.calls[0];
  return { response, headers: call?.[1].headers, sent: call && JSON.parse(call[1].body) };
}

function expectListed(model, name, format, caps, levels) {
  expect(factoryRegistry.models.find(({ id }) => id === model)).toEqual({ id: model, name, targetFormat: format, supportedFormats: [format] });
  expect(getCapabilitiesForModel("factory", model)).toMatchObject({ vision: true, reasoning: true, ...caps });
  for (const provider of ["factory", "fy", "droid"]) expect(getThinkingLevels(provider, model), provider).toEqual(levels);
}

// The three models Droid 1.10.0 adds, as its registry and builders have them.
// Each is behind a statsig flag that defaults to false, as Gemini 4 Argon,
// Kimi K3.1 Pro and GLM 5.2 Fast are, and 9router lists those.
describe("Factory models added in Droid 1.10.0", () => {
  it("lists Claude Fable 5.2 with Droid's limits and efforts, no off effort", () => {
    expectListed("claude-fable-5.2", "Claude Fable 5.2 (Factory)", "claude",
      { thinkingFormat: "claude-adaptive", thinkingCanDisable: false, contextWindow: 995_000, maxOutput: 128000 },
      ["low", "medium", "high", "xhigh", "max"]);
  });

  it("sends Fable 5.2 Droid's bound adaptive thinking on anthropic, default high", async () => {
    const { response, headers, sent } = await send("claude-fable-5.2", { messages: hi });
    expect(response.status).toBe(200);
    expect(headers["x-api-provider"]).toBe("anthropic");
    expect(headers["anthropic-beta"]).toBe("thinking-binding-controls-2026-08-01");
    expect(sent).toMatchObject({
      thinking: { type: "adaptive", display: "summarized", block_binding: { prefix_mismatch_behavior: "drop_block" } },
      output_config: { effort: "high" },
    });
    expect((await send("claude-fable-5.2", { messages: hi }, region("us"))).headers["x-api-provider"]).toBe("anthropic");
  });

  it("stops Fable 5.2 in eu before any fetch, as Droid has no eu provider for it", async () => {
    const { response } = await send("claude-fable-5.2", { messages: hi }, region("eu"));
    expect(proxyAwareFetch).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe("No providers available for this turn (model claude-fable-5.2, region eu)");
  });

  it("lists Gemini 4 Hydrogen and sends Droid's body in every region, default high", async () => {
    expectListed("gemini-4-hydrogen", "Gemini 4 Hydrogen (Factory)", "gemini",
      { thinkingFormat: "gemini-level", thinkingCanDisable: false, contextWindow: 1_065_536, maxOutput: 65536 },
      ["low", "medium", "high"]);
    for (const r of ["global", "eu", "us"]) {
      const { headers, sent } = await send("gemini-4-hydrogen", { messages: hi }, region(r));
      expect(headers["x-api-provider"], r).toBe("google");
      expect(sent.generationConfig, r).toMatchObject({ temperature: 1, topP: 0.95, topK: 64, thinkingConfig: { includeThoughts: true, thinkingLevel: "HIGH" } });
    }
  });

  it("lists Gemini 4 Carbon like Argon: global only, default medium", async () => {
    expectListed("gemini-4-carbon", "Gemini 4 Carbon (Factory)", "gemini",
      { thinkingFormat: "gemini-level", thinkingCanDisable: false, contextWindow: 1_000_000, maxOutput: 65536 },
      ["low", "medium", "high"]);
    const { headers, sent } = await send("gemini-4-carbon", { messages: hi });
    expect(headers["x-api-provider"]).toBe("google");
    expect(sent.generationConfig).toMatchObject({ maxOutputTokens: 65536, thinkingConfig: { includeThoughts: true, thinkingLevel: "MEDIUM" } });
    expect(sent.generationConfig.temperature).toBeUndefined();
    const { response } = await send("gemini-4-carbon", { messages: hi }, region("eu"));
    expect(response.status).toBe(400);
  });
});
