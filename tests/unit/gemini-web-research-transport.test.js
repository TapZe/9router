import { describe, expect, it } from "vitest";
import { generateGeminiWeb } from "../../open-sse/executors/gemini-web/protocol.js";
import { decodeGeminiWebStream } from "../../open-sse/executors/gemini-web/stream.js";
import { parseGeminiModels } from "../../open-sse/executors/gemini-web/models.js";
import { BOOTSTRAP_HTML, SYNTHETIC_COOKIE, SYNTHETIC_AT, SYNTHETIC_API_KEY, modelDiscoveryBody, modelEntry, policyGroup, answerFrame, imageFrame, lengthPrefixedBody } from "../fixtures/gemini-web/wireFixtures.js";
import { ARGON_BIND_RECORDS, ARGON_BIND_FINAL_TEXT, argonBindBody } from "../fixtures/gemini-web/argonBindFixtures.js";
import { GeminiWebExecutor } from "../../open-sse/executors/gemini-web.js";
import { TINY_PNG } from "../fixtures/gemini-web/imageFixtures.js";

// The dedicated test-account browser selected Detailed research / Pro and
// opened ProcessSession with this exact model id and model number 3.
const PRO_MODEL_ID = "e6fa609c3fa255c0";
const finalRecord = ARGON_BIND_RECORDS.find(record => record.kind === "final-answer");
const session = { cookieHeader: SYNTHETIC_COOKIE, at: SYNTHETIC_AT, apiConsumerKey: SYNTHETIC_API_KEY, language: "en" };
function proModel(display) {
  const { models } = parseGeminiModels(modelDiscoveryBody({ tiers: [8], entries: [modelEntry(PRO_MODEL_ID, "Pro", display, 3)] }));
  return models[0];
}
async function output(response) {
  let answer = "";
  for await (const event of decodeGeminiWebStream(response.body)) if (event.type === "text") answer = event.text;
  return answer;
}

describe("Gemini Web Detailed research generation transport", () => {
  it("keeps the exact Pro model on its browser transport under a localized label", async () => {
    const selected = proModel("Recherche detaillee");
    const calls = [];
    const transport = async (url, options) => {
      const parsed = new URL(url);
      calls.push({ path: parsed.pathname, method: options.method, body: String(options.body || "") });
      if (parsed.pathname.includes("StreamGenerate")) return new Response("wrong transport", { status: 400 });
      if (options.method === "GET") return new Response(argonBindBody([finalRecord]));
      if (String(options.body).startsWith("count=0")) return new Response('[[0,["c","synthetic-research-channel","0",8]]]', { headers: { "x-http-session-id": "synthetic-research-session" } });
      return new Response("[[0,0,0]]");
    };

    const response = await generateGeminiWeb({ session, model: selected, prompt: "hello", thinkingLevel: "low", transport });
    expect(response.status).toBe(200);
    expect(await output(response)).toBe(ARGON_BIND_FINAL_TEXT);
    expect(selected.modelId).toBe(PRO_MODEL_ID);
    expect(selected.modelNumber).toBe(3);
    expect(selected.policy).not.toBe(true);
    expect(calls.every(call => call.path === "/v1/processSession")).toBe(true);
    const sends = calls.filter(call => call.body.includes("req1___data__"));
    expect(sends).toHaveLength(1);
    expect(Buffer.from(new URLSearchParams(sends[0].body).get("req0___data__"), "base64").toString("utf8")).toContain(PRO_MODEL_ID);
  });

  it("carries an unlisted hex model on the channel when the label says Detailed research", async () => {
    const { models } = parseGeminiModels(modelDiscoveryBody({
      tiers: [8],
      entries: [modelEntry("unlisted-account-model", "Other", "Detailed research", 1)],
    }));
    const calls = [];
    const response = await generateGeminiWeb({
      session,
      model: models[0],
      prompt: "hello",
      thinkingLevel: "low",
      transport: async (url, options) => {
        const parsed = new URL(url);
        calls.push({ path: parsed.pathname, body: String(options.body || "") });
        if (parsed.pathname.includes("StreamGenerate")) return new Response("wrong transport", { status: 400 });
        if (options.method === "GET") return new Response(argonBindBody([finalRecord]));
        if (String(options.body).startsWith("count=0")) return new Response('[[0,["c","synthetic-research-channel","0",8]]]', { headers: { "x-http-session-id": "synthetic-research-session" } });
        return new Response("[[0,0,0]]");
      },
    });

    expect(await output(response)).toBe(ARGON_BIND_FINAL_TEXT);
    expect(calls.every(call => call.path === "/v1/processSession")).toBe(true);
    const sends = calls.filter(call => call.body.includes("req1___data__"));
    expect(sends).toHaveLength(1);
    expect(Buffer.from(new URLSearchParams(sends[0].body).get("req0___data__"), "base64").toString("utf8")).toContain("unlisted-account-model");
  });

  it("falls back to StreamGenerate for an ordinary model without channel identity", async () => {
    const calls = [];
    const response = await generateGeminiWeb({
      session: { ...session, apiConsumerKey: "" },
      model: proModel("Detailed research"),
      prompt: "hello",
      thinkingLevel: "low",
      transport: async (url) => {
        const parsed = new URL(url);
        calls.push(parsed.pathname);
        if (parsed.pathname.includes("processSession")) return new Response("wrong transport", { status: 400 });
        return new Response(lengthPrefixedBody([answerFrame("streamed answer")]));
      },
    });

    expect(await output(response)).toBe("streamed answer");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("StreamGenerate");
  });

  it("rejects a policy code without channel identity before dispatch", async () => {
    const { models } = parseGeminiModels(modelDiscoveryBody({
      tiers: [8],
      entries: [modelEntry(PRO_MODEL_ID, "Pro", "Detailed research", 3)],
      policy: [null, [policyGroup("synthetic-policy-code", "Code", "Code & analysis", 2)]],
    }));
    const policyModel = models.find((model) => model.policy === true);
    expect(policyModel).toBeTruthy();

    let dispatches = 0;
    let requests = 0;
    await expect(generateGeminiWeb({
      session: { ...session, apiConsumerKey: "" },
      model: policyModel,
      prompt: "hello",
      thinkingLevel: "low",
      onDispatch: () => { dispatches += 1; },
      transport: async () => { requests += 1; return new Response("unexpected"); },
    })).rejects.toMatchObject({ status: 502 });
    expect(requests).toBe(0);
    expect(dispatches).toBe(0);
  });

  it("preserves the existing Pro attachment transport and uploaded file encoding", async () => {
    const calls = [];
    const file = { id: "synthetic-uploaded-pro-image", name: "diagram.png" };
    const response = await generateGeminiWeb({
      session,
      model: proModel("Detailed research"),
      prompt: "Describe [Image 1]",
      files: [file],
      thinkingLevel: "low",
      transport: async (url, options) => {
        calls.push({ path: new URL(url).pathname, body: String(options.body || "") });
        return new Response(lengthPrefixedBody([answerFrame("image-aware answer")]));
      },
    });

    expect(await output(response)).toBe("image-aware answer");
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toContain("StreamGenerate");
    const request = JSON.parse(new URLSearchParams(calls[0].body).get("f.req"));
    const inner = JSON.parse(request[1]);
    expect(inner[0][3]).toEqual([[[file.id], file.name]]);
    expect(inner[79]).toBe(3);
  });

  it("keeps image generation on its existing transport when Pro is the only catalog model", async () => {
    const generations = [];
    const transport = async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.includes("processSession")) return new Response("unsupported image transport", { status: 400 });
      if (parsed.pathname.includes("StreamGenerate")) {
        generations.push(parsed.pathname);
        return new Response(lengthPrefixedBody([imageFrame({ url: "https://lh3.googleusercontent.com/synthetic-pro-image" })]));
      }
      if (parsed.hostname === "lh3.googleusercontent.com") return new Response(TINY_PNG, { headers: { "content-type": "image/png" } });
      if (parsed.searchParams.has("rpcids")) return new Response(modelDiscoveryBody({
        tiers: [8], entries: [modelEntry(PRO_MODEL_ID, "Pro", "Detailed research", 3)],
      }));
      return new Response(parsed.pathname.endsWith("/app") ? BOOTSTRAP_HTML : "warm");
    };
    const now = new Date().toISOString();
    const record = { id: "synthetic-pro-image-jar", cookieHeader: SYNTHETIC_COOKIE, revision: 1, lastRotatedAt: now };
    const images = await new GeminiWebExecutor().generateMedia({
      prompt: "A blue square", n: 1,
      credentials: {
        connectionId: "synthetic-pro-image-account", apiKey: SYNTHETIC_COOKIE,
        providerSpecificData: { authUser: "" },
        geminiWebSession: { id: record.id, read: async () => record },
      },
      transport,
    });

    expect(images).toMatchObject([{ mime: "image/png", b64: TINY_PNG.toString("base64") }]);
    expect(generations).toHaveLength(1);
  });
});
