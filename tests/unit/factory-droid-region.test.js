import { describe, expect, it } from "vitest";
import { FactoryExecutor, factoryInferenceRegion, upstreamProviderFor } from "../../open-sse/executors/factory.js";

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

  it("falls back to the global provider when Droid lists none for the region", () => {
    expect(upstreamProviderFor("grok-4.5", "eu")).toBe("xai");
    expect(upstreamProviderFor("gpt-5.1", "eu")).toBe("openai");
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
