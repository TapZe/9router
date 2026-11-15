import { describe, expect, it } from "vitest";
import { handleComboChat } from "../../open-sse/services/combo.js";
import { isNonReplayableResponse, markNonReplayableResponse } from "../../open-sse/utils/replayPolicy.js";

const silentLog = { info() {}, warn() {}, debug() {} };

describe("Gemini Web no-replay routing", () => {
  it("does not dispatch a second member after a marked Gemini generation", async () => {
    const calls = [];
    const first = markNonReplayableResponse(
      new Response(JSON.stringify({ error: { message: "no image", code: "gemini_web_no_image" } }), {
        status: 502,
        headers: { "content-type": "application/json" },
      })
    );

    const result = await handleComboChat({
      body: { prompt: "red square" },
      models: ["gemini-web/gemini-image", "other/fallback-image"],
      handleSingleModel: async (_body, model) => {
        calls.push(model);
        if (model.startsWith("gemini-web/")) return first;
        return new Response(JSON.stringify({ created: 1, data: [{ b64_json: "e30=" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
      log: silentLog,
      comboName: "image-fallback",
      comboStrategy: "fallback",
    });

    expect(calls).toEqual(["gemini-web/gemini-image"]);
    expect(result.status).toBe(502);
    expect(isNonReplayableResponse(result)).toBe(true);
  });

  it("returns 499 without trying the next member when the client aborts", async () => {
    const calls = [];
    const controller = new AbortController();
    controller.abort();
    const result = await handleComboChat({
      body: {},
      models: ["gemini-web/gemini-quick-answers", "other/x"],
      handleSingleModel: async (_body, model) => {
        calls.push(model);
        return new Response("{}", { status: 200 });
      },
      log: silentLog,
      comboName: "abort",
      comboStrategy: "fallback",
      signal: controller.signal,
    });
    expect(calls).toEqual([]);
    expect(result.status).toBe(499);
  });
});
