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

const MODEL = "kimi-k3.1-pro";
const region = (inferenceRegion) => ({ accessToken: "tok", providerSpecificData: { inferenceRegion } });

// Sends an OpenAI client request through the translator and the executor and
// returns what would go to Factory.
async function send(body, credentials = { accessToken: "tok" }) {
  proxyAwareFetch.mockClear();
  const { targetFormat } = factoryRegistry.models.find(({ id }) => id === MODEL);
  const translated = translateRequest("openai", targetFormat, MODEL, { model: MODEL, ...body }, true, null, "factory");
  const { response } = await new FactoryExecutor().execute({ model: MODEL, body: translated, stream: true, credentials });
  const call = proxyAwareFetch.mock.calls[0];
  return { response, url: call?.[0], headers: call?.[1].headers, sent: call && JSON.parse(call[1].body) };
}

const hi = [{ role: "user", content: "hi" }];

// Kimi K3.1 Pro as Droid 1.5.0 has it: efforts low, high, max with default
// max, images, contextLimits E(1e6, 131072), fireworks in global, baseten in
// us, and no provider in eu.
describe("Factory Kimi K3.1 Pro from Droid 1.5.0", () => {
  it("is in the model list with Droid's limits, images, and efforts", () => {
    expect(factoryRegistry.models.find(({ id }) => id === MODEL)).toEqual({
      id: MODEL, name: "Kimi K3.1 Pro (Factory)", targetFormat: "openai", supportedFormats: ["openai"],
    });
    expect(getCapabilitiesForModel("factory", MODEL)).toMatchObject({
      vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false,
      contextWindow: 1_000_000, maxOutput: 131072,
    });
    for (const provider of ["factory", "fy", "droid"]) {
      expect(getThinkingLevels(provider, MODEL), provider).toEqual(["low", "high", "max"]);
    }
  });

  it("sends fireworks Droid's body, with max when the client names no effort", async () => {
    const { response, url, headers, sent } = await send({ messages: hi });
    expect(response.status).toBe(200);
    expect(url).toBe("https://api.factory.ai/api/llm/o/v1/chat/completions");
    expect(headers["x-api-provider"]).toBe("fireworks");
    expect(headers["X-Client-Version"]).toBe("1.10.0");
    expect(sent).toMatchObject({ model: MODEL, temperature: 1, reasoning_effort: "max", reasoning_history: "preserved" });
  });

  it("keeps a listed effort and sends the default max for any other", async () => {
    for (const [asked, effort] of [["low", "low"], ["high", "high"], ["max", "max"], ["none", "max"], ["medium", "max"], ["xhigh", "max"]]) {
      const { sent } = await send({ messages: hi, reasoning_effort: asked });
      expect(sent.reasoning_effort, asked).toBe(effort);
    }
  });

  it("sends baseten's body in the us region", async () => {
    const { headers, sent } = await send({ messages: hi }, region("us"));
    expect(headers["x-api-provider"]).toBe("baseten");
    expect(sent).toMatchObject({ temperature: 1, reasoning_effort: "max" });
    expect(sent).not.toHaveProperty("reasoning_history");
  });

  it("stops in the eu region before any fetch, with no fallback to another region", async () => {
    const { response } = await send({ messages: hi }, region("eu"));
    expect(proxyAwareFetch).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe(`No providers available for this turn (model ${MODEL}, region eu)`);
  });
});
