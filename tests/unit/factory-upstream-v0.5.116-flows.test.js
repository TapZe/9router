import { describe, expect, it, vi } from "vitest";
import { FactoryExecutor } from "../../open-sse/executors/factory.js";
import factoryRegistry from "../../open-sse/providers/registry/factory.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { buildModelGroups, collectModelValues } from "@/shared/utils/selectableModels.js";

// No request in this file may reach Factory. The mock records what would be sent.
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })),
}));

// Sends a client request through the translator and the executor and returns
// the body that would go to Factory.
async function send(source, model, body) {
  proxyAwareFetch.mockClear();
  const { targetFormat } = factoryRegistry.models.find(({ id }) => id === model);
  const translated = translateRequest(source, targetFormat, model, { model, ...body }, true, null, "factory");
  await new FactoryExecutor().execute({ model, body: translated, stream: true, credentials: { accessToken: "tok" } });
  return JSON.parse(proxyAwareFetch.mock.calls[0][1].body);
}

// Upstream v0.5.116 flows the Factory provider now goes through.
describe("Factory on upstream v0.5.116 flows", () => {
  // Upstream keeps thinking on OpenAI tool-result turns (cff5328b). Droid
  // sends the session's effort on every turn, so a Factory Claude model must
  // get the asked effort on the tool-result turn too, not its default.
  it("keeps the asked Claude effort on an OpenAI tool-result turn", async () => {
    const toolTurn = [
      { role: "user", content: "list files" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "ls", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "a.txt" },
    ];
    const tools = [{ type: "function", function: { name: "ls", parameters: { type: "object", properties: {} } } }];
    const firstTurn = await send("openai", "claude-opus-5-5", { messages: toolTurn.slice(0, 1), tools, thinking: { type: "enabled", budget_tokens: 2048 } });
    const toolResultTurn = await send("openai", "claude-opus-5-5", { messages: toolTurn, tools, thinking: { type: "enabled", budget_tokens: 2048 } });
    expect(toolResultTurn.output_config).toEqual(firstTurn.output_config);
    expect(toolResultTurn.thinking).toEqual(firstTurn.thinking);
  });

  // Upstream's "Add All Active Models" (69d51c0c) builds its list from the
  // picker groups. A Factory connection must add exactly the Droid models, under the
  // picker alias fy/.
  it("adds every Droid model, and only those, for an active Factory connection", () => {
    const values = collectModelValues(buildModelGroups({
      connections: [{ provider: "factory", isActive: true }],
      allConnections: [{ provider: "factory", isActive: true }],
      modelAliases: {}, customModels: [], disabledModels: {},
    }));
    const factoryValues = values.filter((v) => v.startsWith("fy/"));
    expect(factoryValues.sort()).toEqual(factoryRegistry.models.map(({ id }) => `fy/${id}`).sort());
    expect(factoryValues).toContain("fy/kimi-k3.1-pro");
    expect(factoryValues).not.toContain("fy/gpt-5.1");
  });
});
