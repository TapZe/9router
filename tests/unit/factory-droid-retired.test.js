import { describe, expect, it, vi } from "vitest";
import { FactoryExecutor } from "../../open-sse/executors/factory.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";

// No request in this file may reach Factory. The mock records what would be sent.
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })),
}));

// Droid 1.3.0 no longer offers these ids. It runs a model it does not offer
// on its default model, gpt-6.1-sol, and shows that model's limits.
const RETIRED = ["gpt-5", "gpt-5.1", "gpt-5-codex", "gpt-5.1-codex"];

describe("GPT models Droid 1.3.0 no longer offers", () => {
  it("shows the limits, vision, and efforts of gpt-6.1-sol", () => {
    const sol = getCapabilitiesForModel("factory", "gpt-6.1-sol");
    for (const id of RETIRED) {
      expect(getCapabilitiesForModel("factory", id), id).toEqual(sol);
      expect(getCapabilitiesForModel("fy", id), id).toEqual(sol);
      expect(getThinkingLevels("factory", id), id).toEqual(getThinkingLevels("factory", "gpt-6.1-sol"));
    }
    expect(sol.maxOutput).toBe(128000);
  });

  it("sends the request as gpt-6.1-sol", async () => {
    for (const id of RETIRED) {
      proxyAwareFetch.mockClear();
      const executor = new FactoryExecutor();
      const body = { model: id, input: [{ role: "user", content: "hi" }], reasoning: { effort: "high" } };
      await executor.execute({ model: `fy/${id}`, body, stream: true, credentials: { accessToken: "tok" } });
      const [url, options] = proxyAwareFetch.mock.calls[0];
      const sent = JSON.parse(options.body);
      expect(url, id).toMatch(/\/api\/llm\/o\/v1\/responses$/);
      expect(sent.model, id).toBe("gpt-6.1-sol");
      expect(sent.reasoning, id).toEqual({ effort: "high", summary: "auto" });
      expect(options.headers["x-api-provider"], id).toBe("openai");
    }
  });
});
