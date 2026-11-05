import { describe, expect, it, vi } from "vitest";
import { FactoryExecutor } from "../../open-sse/executors/factory.js";
import { PROVIDER_CAPABILITIES } from "../../open-sse/providers/capabilities.js";
import { FACTORY_DROID_MODELS } from "../../open-sse/providers/factoryDroid.js";
import { FACTORY_DROID_REQUESTS } from "../../open-sse/providers/factoryDroidRequests.js";
import factoryRegistry from "../../open-sse/providers/registry/factory.js";
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";

// No request in this file may reach Factory. The mock records what would be sent.
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })),
}));

// Droid 1.3.0 does not offer these ids, and 9router no longer has them.
const REMOVED = [
  "glm-4.6", "kimi-k2.7-code", "kimi-k2.6", "minimax-m2.5", "gemini-3-pro-preview",
  "gpt-5", "gpt-5.1", "gpt-5-codex", "gpt-5.1-codex",
];

describe("Factory models removed with Droid 1.3.0", () => {
  it("are gone from the model list, capabilities, and Droid tables", () => {
    for (const id of REMOVED) {
      expect(factoryRegistry.models.some((model) => model.id === id), id).toBe(false);
      expect(PROVIDER_CAPABILITIES.factory[id], id).toBeUndefined();
      expect(FACTORY_DROID_MODELS[id], id).toBeUndefined();
      expect(FACTORY_DROID_REQUESTS[id], id).toBeUndefined();
    }
  });

  // Droid's registry throws "Unknown model" for an id it does not have.
  it("get the unknown model error before any fetch, the same as any id Factory does not list", async () => {
    for (const id of [...REMOVED, "fy/" + REMOVED[0], "some-model-factory-never-had"]) {
      proxyAwareFetch.mockClear();
      const executor = new FactoryExecutor();
      const body = { model: id, messages: [{ role: "user", content: "hi" }] };
      const { response } = await executor.execute({ model: id, body, stream: true, credentials: { accessToken: "tok" } });
      expect(proxyAwareFetch, id).not.toHaveBeenCalled();
      expect(response.status, id).toBe(400);
      expect((await response.json()).error.message, id).toBe(`Unknown model: ${id.replace(/^fy\//, "")}`);
    }
  });
});
