import { describe, expect, it, vi } from "vitest";
import { FactoryExecutor, factoryInferenceRegion, upstreamProviderFor } from "../../open-sse/executors/factory.js";
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";

// No request in this file may reach Factory.
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(async () => { throw new Error("no network in this test"); }),
}));

const withData = (providerSpecificData) => ({ accessToken: "tok", providerSpecificData });

describe("Factory inference region from Droid 1.3.0", () => {
  it("reads the region the way Droid does", () => {
    // Droid uses inferenceRegion when it is valid, else sends an eu org to eu and others to global.
    expect(factoryInferenceRegion(withData({ inferenceRegion: "us", region: "eu" }))).toBe("us");
    expect(factoryInferenceRegion(withData({ inferenceRegion: "eu" }))).toBe("eu");
    expect(factoryInferenceRegion(withData({ inferenceRegion: "mars", region: "eu" }))).toBe("eu");
    expect(factoryInferenceRegion(withData({ region: "global" }))).toBe("global");
    expect(factoryInferenceRegion(withData({}))).toBe("global");
    expect(factoryInferenceRegion(null)).toBe("global");
  });

  it("keeps saved connections that only stored an EU endpoint in eu", () => {
    expect(factoryInferenceRegion(withData({ region: null, apiEndpoint: "https://api.eu.factory.ai" }))).toBe("eu");
    expect(factoryInferenceRegion(withData({ region: null, apiEndpoint: "https://api.factory.ai" }))).toBe("global");
    expect(factoryInferenceRegion(withData({ apiEndpoint: "not a url" }))).toBe("global");
  });

  it("picks the provider Droid uses in each region", () => {
    expect(upstreamProviderFor("claude-opus-4-8", "eu")).toBe("vertex_anthropic");
    expect(upstreamProviderFor("claude-sonnet-4-5-20250929", "us")).toBe("vertex_anthropic");
    expect(upstreamProviderFor("glm-5.3", "eu")).toBe("mistral");
    expect(upstreamProviderFor("kimi-k3", "us")).toBe("baseten");
    expect(upstreamProviderFor("kimi-k3", "global")).toBe("fireworks");
  });

  it("finds no provider when Droid lists none for the region", () => {
    expect(upstreamProviderFor("grok-4.5", "eu")).toBeNull();
    expect(upstreamProviderFor("grok-4.5", "us")).toBeNull();
    expect(upstreamProviderFor("gemini-3.1-pro-preview", "us")).toBeNull();
    expect(upstreamProviderFor("grok-4.5", "global")).toBe("xai");
  });

  it("fails the request before any fetch when the region has no provider", async () => {
    proxyAwareFetch.mockClear();
    const executor = new FactoryExecutor();
    const body = { model: "grok-4.5", messages: [{ role: "user", content: "hi" }] };
    const { response } = await executor.execute({ model: "grok-4.5", body, stream: true, credentials: withData({ inferenceRegion: "eu" }) });
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe("No providers available for this turn (model grok-4.5, region eu)");
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("sends the regional provider in x-api-provider", () => {
    const executor = new FactoryExecutor();
    const eu = withData({ apiEndpoint: "https://api.eu.factory.ai" });
    expect(executor.buildHeaders(eu, true, "", "claude-opus-4-8")["x-api-provider"]).toBe("vertex_anthropic");
    const us = withData({ inferenceRegion: "us" });
    expect(executor.buildHeaders(us, true, "", "kimi-k3")["x-api-provider"]).toBe("baseten");
    expect(executor.buildHeaders({ accessToken: "tok" }, true, "", "kimi-k3")["x-api-provider"]).toBe("fireworks");
  });
});
