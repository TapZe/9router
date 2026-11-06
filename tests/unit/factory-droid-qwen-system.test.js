import { describe, expect, it, vi } from "vitest";
import { FactoryExecutor, FACTORY_DROID_SYSTEM_PROMPT } from "../../open-sse/executors/factory.js";
import { FACTORY_DROID_MODELS } from "../../open-sse/providers/factoryDroid.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";

// No request in this file may reach Factory. The mock records what would be sent.
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })),
}));

async function send(model, messages) {
  proxyAwareFetch.mockClear();
  const translated = translateRequest("openai", "openai", model, { model, messages }, true, null, "factory");
  await new FactoryExecutor().execute({ model, body: translated, stream: true, credentials: { accessToken: "tok" } });
  return JSON.parse(proxyAwareFetch.mock.calls[0][1].body).messages;
}

const conversation = [
  { role: "system", content: "Be brief." },
  { role: "user", content: "hi" },
  { role: "system", content: "  Plan mode is on.  " },
  { role: "assistant", content: "ok" },
  { role: "system", content: " <system-reminder>\nAlready wrapped.\n</system-reminder>\n" },
  { role: "system", content: [{ type: "text", text: "Part one." }, { type: "text", text: "Part two." }] },
  { role: "developer", content: "Developer note." },
  { role: "user", content: "go" },
];

// Droid 1.5.0 gives Qwen3.8 Max systemMessageOnlyAtBeginning. Its c4 step
// keeps the first system message and turns each later one into a user
// message. The text is the string content, or the text parts joined by a
// newline. Text that is already wrapped in <system-reminder> after a trim
// keeps its untrimmed form. Other text is wrapped as is.
describe("Factory Qwen3.8 Max later system messages from Droid 1.5.0", () => {
  it("is the only model with the rule", () => {
    const flagged = Object.keys(FACTORY_DROID_MODELS).filter((id) => FACTORY_DROID_MODELS[id].systemMessageOnlyAtBeginning);
    expect(flagged).toEqual(["qwen3.8-max"]);
  });

  it("keeps the first system message and turns later ones into system reminders", async () => {
    const sent = await send("qwen3.8-max", conversation);
    expect(sent).toEqual([
      { role: "system", content: `${FACTORY_DROID_SYSTEM_PROMPT}\n\nBe brief.` },
      { role: "user", content: "hi" },
      { role: "user", content: "<system-reminder>\n  Plan mode is on.  \n</system-reminder>" },
      { role: "assistant", content: "ok" },
      { role: "user", content: " <system-reminder>\nAlready wrapped.\n</system-reminder>\n" },
      { role: "user", content: "<system-reminder>\nPart one.\nPart two.\n</system-reminder>" },
      // The translator sends a developer message on as system, so it is a later system message too.
      { role: "user", content: "<system-reminder>\nDeveloper note.\n</system-reminder>" },
      { role: "user", content: "go" },
    ]);
  });

  it("gives the same messages when a converted request goes through again", async () => {
    const once = await send("qwen3.8-max", conversation);
    expect(await send("qwen3.8-max", once)).toEqual(once);
  });

  it("leaves later system messages alone for models without the rule", async () => {
    for (const model of ["kimi-k3", "kimi-k3.1-pro", "glm-5.3", "deepseek-v4-pro"]) {
      const sent = await send(model, conversation);
      expect(sent.filter((m) => m.role === "system"), model).toHaveLength(5);
    }
  });
});
