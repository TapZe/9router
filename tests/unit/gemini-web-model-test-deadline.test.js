import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/localDb", () => ({ getApiKeys: vi.fn(async () => []) }));
vi.mock("@/shared/utils/machineId", () => ({ getConsistentMachineId: vi.fn(async () => "test-cli-token") }));
const { pingModelByKind } = await import("../../src/app/api/models/test/ping.js");
const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
let server;
let baseUrl;
const timers = new Set();

beforeEach(async () => {
  // Scale the real abort deadlines and upstream latency together. No real accounts are used.
  vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => nativeTimeout(Math.ceil(milliseconds / 1000)));
  server = http.createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    if (body.model.endsWith("stalled")) return;
    const timer = setTimeout(() => {
      timers.delete(timer);
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(request.url.includes("/images/")
        ? { data: [{ b64_json: "synthetic-image" }] }
        : { choices: [{ message: { content: "hello" }, finish_reason: "stop" }] }));
    }, 60);
    timers.add(timer);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

describe("Gemini Web dashboard model-test deadlines", () => {
  it.each(["gemini-web/gemini-everyday-help", "gweb/gemini-detailed-research"])(
    "accepts %s completing after the ordinary model-test deadline", async (model) => {
      const result = await pingModelByKind(model, "llm", baseUrl);
      expect(result).toMatchObject({ ok: true, status: 200, error: null });
    }
  );

  it("allows a Gemini image model to finish beyond the ordinary deadline", async () => {
    const result = await pingModelByKind("gweb/gemini-image", "image", baseUrl);
    expect(result).toMatchObject({ ok: true, status: 200, error: null });
  });

  it("retains the existing deadline for unrelated providers", async () => {
    await expect(pingModelByKind("openai/gpt-test", "llm", baseUrl)).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("still cancels a stalled Gemini test at its provider deadline", async () => {
    await expect(pingModelByKind("gweb/stalled", "llm", baseUrl)).rejects.toMatchObject({ name: "TimeoutError" });
  });
});
