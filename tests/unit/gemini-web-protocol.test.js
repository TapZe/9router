import { describe, expect, it, vi } from "vitest";

import {
  GEMINI_WEB_DEFAULT_LANGUAGE,
  GEMINI_WEB_DEFAULT_PUSH_ID,
  GEMINI_WEB_LIMITS,
  GEMINI_WEB_MODEL_HEADER,
  GEMINI_WEB_USER_AGENT,
} from "../../open-sse/executors/gemini-web/config.js";
import {
  bootstrapGeminiWeb,
  generateGeminiWeb,
  geminiAccountUrl,
  geminiSourcePath,
} from "../../open-sse/executors/gemini-web/protocol.js";
import {
  encodeProcessSessionReq0,
  encodeProcessSessionReq1,
  extractProcessSessionAnswer,
  parseBrowserChannelOpen,
  protoToBase64,
  readBindUntilAnswer,
  streamBodyFromAnswerText,
} from "../../open-sse/executors/gemini-web/processSession.js";
import {
  fetchGeminiWebModels,
  parseGeminiModels,
  resolveGeminiModel,
} from "../../open-sse/executors/gemini-web/models.js";
import { decodeGeminiWebStream } from "../../open-sse/executors/gemini-web/stream.js";
import {
  BARD_ERROR_FIXTURE,
  BOOTSTRAP_HTML,
  BOOTSTRAP_HTML_FALLBACK_ARRAY,
  SIGN_IN_HTML,
  SYNTHETIC_AT,
  SYNTHETIC_BUILD,
  SYNTHETIC_COOKIE,
  SYNTHETIC_GENERATION_ID,
  SYNTHETIC_GOOGLE_SESSION,
  answerFrame,
  imageFrame,
  labelFrame,
  labelPayload,
  lengthPrefixedBody,
  modelDiscoveryBody,
  modelEntry,
  modelStatusFixture,
  policyGroup,
  payloadFrame,
  streamFromText,
  usageFrame,
} from "../fixtures/gemini-web/wireFixtures.js";
import {
  ARGON_BIND_FINAL_TEXT,
  ARGON_BIND_PARTIAL_TEXT,
  ARGON_BIND_RECORDS,
  argonBindBody,
} from "../fixtures/gemini-web/argonBindFixtures.js";

const BASE_SESSION = Object.freeze({
  cookieHeader: SYNTHETIC_COOKIE,
  at: SYNTHETIC_AT,
  pushId: GEMINI_WEB_DEFAULT_PUSH_ID,
  buildLabel: SYNTHETIC_BUILD,
  sessionId: SYNTHETIC_GOOGLE_SESSION,
  language: "en",
  generationId: SYNTHETIC_GENERATION_ID,
  models: [],
});

const FLASH_MODEL = Object.freeze({
  id: "gemini-3.8-flash",
  name: "Gemini 3.8 Flash",
  modelId: "account-flash-id",
  modelNumber: 1,
  capacity: 2,
  capacityField: 12,
});

const ARGON_MODEL = Object.freeze({
  id: "gemini-code-analysis",
  name: "Code & analysis",
  modelId: "argon",
  modelNumber: 8,
  capacity: 2,
  capacityField: 12,
  policy: true,
});

function createTransport(handler) {
  const calls = [];
  const transport = vi.fn(async (url, options = {}, proxyOptions = null) => {
    const call = { url: String(url), options, proxyOptions };
    calls.push(call);
    return handler(call);
  });
  return { transport, calls };
}

function header(call, name) {
  const headers = call.options.headers || {};
  const found = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase());
  return found ? headers[found] : undefined;
}

function requestUrl(call) {
  return new URL(call.url);
}

function formOf(call) {
  return new URLSearchParams(call.options.body);
}

function jsonBody(json) {
  return new Response(json, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function redirect(location, { status = 302, cookies = [] } = {}) {
  const headers = new Headers({ location });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status, headers });
}

function bootstrapTransport({ warmup, root, app, models } = {}) {
  let appCalls = 0;
  return createTransport((call) => {
    const url = requestUrl(call);
    if (url.origin === "https://www.google.com") {
      return warmup
        ? warmup(call)
        : new Response("warm", {
            status: 200,
            headers: { "set-cookie": "NID=warm; Domain=.google.com" },
          });
    }
    if (url.searchParams.has("rpcids")) {
      return models
        ? models(call)
        : jsonBody(
            modelDiscoveryBody({
              tiers: [8],
              entries: [modelEntry("account-flash-id", "Fast", "Gemini 3.8 Flash", 1)],
            })
          );
    }
    if (url.pathname === "/") {
      return root
        ? root(call)
        : new Response("primed", {
            status: 200,
            headers: { "set-cookie": "SIDCC=primed; Domain=.google.com" },
          });
    }
    if (url.pathname.endsWith("/app")) {
      appCalls += 1;
      if (app) return app(call, appCalls);
      return new Response(BOOTSTRAP_HTML, {
        status: 200,
        headers: { "set-cookie": "__Secure-1PSIDTS=rotated; Domain=.google.com" },
      });
    }
    throw new Error(`unexpected bootstrap request: ${call.url}`);
  });
}

async function collect(iterable) {
  const events = [];
  for await (const event of iterable) events.push(event);
  return events;
}

async function collectUntilError(iterable) {
  const events = [];
  let error = null;
  try {
    for await (const event of iterable) events.push(event);
  } catch (caught) {
    error = caught;
  }
  return { events, error };
}

describe("Gemini Web account-slot URLs", () => {
  it("keeps the default root path and gives an explicit slot zero its own /u/0 path", () => {
    expect(geminiAccountUrl("https://gemini.google.com/app", "")).toBe("https://gemini.google.com/app");
    expect(geminiSourcePath("")).toBe("/app");

    expect(geminiAccountUrl("https://gemini.google.com/app", "0")).toBe(
      "https://gemini.google.com/u/0/app"
    );
    expect(geminiAccountUrl("https://gemini.google.com/app", "2")).toBe(
      "https://gemini.google.com/u/2/app"
    );
    expect(geminiSourcePath("0")).toBe("/u/0/app");
    expect(geminiSourcePath("2")).toBe("/u/2/app");
  });

  it("prefixes only Gemini app endpoints, never rotation or upload URLs", () => {
    const rotate = "https://accounts.google.com/RotateCookies";
    const upload = "https://content-push.googleapis.com/upload";
    expect(geminiAccountUrl(rotate, "2")).toBe(rotate);
    expect(geminiAccountUrl(upload, "2")).toBe(upload);
    expect(
      geminiAccountUrl(
        "https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate",
        "2"
      )
    ).toBe(
      "https://gemini.google.com/u/2/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate"
    );
  });

  it.each(["-1", "1.5", "abc", "1e3", " 1", "01", "9007199254740992"])(
    "rejects invalid account slot %s instead of treating it as a number",
    (slot) => {
      expect(() => geminiSourcePath(slot)).toThrowError(
        expect.objectContaining({ status: 400 })
      );
      expect(() => geminiAccountUrl("https://gemini.google.com/app", slot)).toThrowError(
        expect.objectContaining({ status: 400 })
      );
    }
  );
});

describe("Gemini Web bootstrap", () => {
  it("reads the selected slot's name only from a menu matching its bootstrap email", async () => {
    const { transport } = bootstrapTransport({
      app: (call) => {
        const slot = requestUrl(call).pathname.includes("/u/2/") ? "2" : "0";
        return new Response(`${BOOTSTRAP_HTML}<script>window.WIZ_global_data = ${JSON.stringify({ oPEP7c: `slot${slot}@example.test` })}</script>
          <a aria-label="Google Account: Other Account (other@example.test)"></a>
          <a aria-label="Google Account: Slot ${slot} &amp; Team&#10;(slot${slot}@example.test)"></a>`);
      },
    });
    for (const authUser of ["0", "2"]) {
      const session = await bootstrapGeminiWeb({ cookieHeader: SYNTHETIC_COOKIE, authUser, transport });
      expect(session.account).toEqual({ name: `Slot ${authUser} & Team`, email: `slot${authUser}@example.test` });
    }
  });

  it("uses the active email when a menu belongs to another account or is localized", async () => {
    const { transport } = bootstrapTransport({
      app: () => new Response(`${BOOTSTRAP_HTML}<script>window.WIZ_global_data = {"oPEP7c":"active\\u0040example.test"}</script>
        <a aria-label="Google Account: Wrong Name (other@example.test)"></a>`),
    });
    const session = await bootstrapGeminiWeb({ cookieHeader: SYNTHETIC_COOKIE, authUser: "2", transport });
    expect(session.account).toEqual({ name: "active@example.test", email: "active@example.test" });
  });

  it.each(["", '"oPEP7c":"not-an-email"', '"oPEP7c":"bad\\q@example.test"',
    '"oPEP7c":"bad\\u001b@example.test"', '"oPEP7c":"bad\\u0000@example.test"'])(
    "does not invent an identity from unrelated page emails (%s)", async (identity) => {
      const { transport } = bootstrapTransport({
        app: () => new Response(`${BOOTSTRAP_HTML}<script>{${identity}}</script><a aria-label="Google Account: Other (other@example.test)"></a>`),
      });
      const session = await bootstrapGeminiWeb({ cookieHeader: SYNTHETIC_COOKIE, authUser: "2", transport });
      expect(session.account).toBeNull();
      expect(session.models[0].id).toBe("gemini-3.8-flash");
    }
  );

  it("follows the signed-in redirect chain, merges cookies, and extracts every bootstrap token", async () => {
    const { transport, calls } = bootstrapTransport({
      app: (call, callNumber) =>
        callNumber === 1
          ? redirect("/app", { cookies: ["SIDCC=flow; Domain=.google.com"] })
          : new Response(BOOTSTRAP_HTML, {
              status: 200,
              headers: { "set-cookie": "__Secure-1PSIDTS=rotated; Domain=.google.com" },
            }),
    });
    const result = await bootstrapGeminiWeb({
      cookieHeader: SYNTHETIC_COOKIE,
      authUser: "",
      proxyOptions: { enabled: false },
      transport,
    });

    expect(result.at).toBe(SYNTHETIC_AT);
    expect(result.pushId).toBe("feeds/synthetic-push");
    expect(result.buildLabel).toBe(SYNTHETIC_BUILD);
    expect(result.sessionId).toBe(SYNTHETIC_GOOGLE_SESSION);
    expect(result.language).toBe("vi");
    expect(result.models).toEqual([
      {
        id: "gemini-3.8-flash",
        name: "Gemini 3.8 Flash",
        modelId: "account-flash-id",
        modelNumber: 1,
        capacity: 2,
        capacityField: 12,
      },
    ]);
    expect(result.generationId).toMatch(
      /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/
    );

    const [warmupCall, rootCall, rootFollowCall, appCall, modelCall] = calls;
    expect(warmupCall.url).toBe("https://www.google.com/");
    expect(header(warmupCall, "cookie")).toBeUndefined();
    expect(rootCall.url).toContain("https://gemini.google.com/");
    expect(header(rootCall, "cookie")).toContain("NID=warm");
    expect(header(rootFollowCall, "cookie")).toContain("SIDCC=primed");
    expect(header(appCall, "cookie")).toContain("__Secure-1PSID=synthetic-psid-value");
    expect(header(appCall, "cookie")).toContain("__Secure-1PSIDTS=synthetic-psidts-value");
    expect(header(modelCall, "cookie")).toBe(result.cookieHeader);

    for (const call of calls) {
      expect(call.options.redirect).toBe("manual");
      expect(call.options.strictTls).toBe(true);
      expect(call.options.maxHeaderSize).toBe(GEMINI_WEB_LIMITS.maxHeaderSize);
      expect(call.proxyOptions).toMatchObject({ enabled: false, strictProxy: true });
    }

    const modelUrl = requestUrl(modelCall);
    expect(modelUrl.pathname).toBe("/_/BardChatUi/data/batchexecute");
    expect(modelUrl.searchParams.get("rpcids")).toBe("otAQ7b");
    expect(modelUrl.searchParams.get("hl")).toBe("vi");
    expect(modelUrl.searchParams.get("rt")).toBe("c");
    expect(modelUrl.searchParams.get("source-path")).toBe("/app");
    expect(modelUrl.searchParams.get("bl")).toBe(SYNTHETIC_BUILD);
    expect(modelUrl.searchParams.get("f.sid")).toBe(SYNTHETIC_GOOGLE_SESSION);
    expect(Number(modelUrl.searchParams.get("_reqid"))).toBeGreaterThanOrEqual(10000);
    expect(Number(modelUrl.searchParams.get("_reqid"))).toBeLessThanOrEqual(99999);
    expect(formOf(modelCall).get("at")).toBe(SYNTHETIC_AT);
    expect(formOf(modelCall).get("f.req")).toBe('[[["otAQ7b","[]",null,"generic"]]]');

    const batchHeader = JSON.parse(header(modelCall, GEMINI_WEB_MODEL_HEADER));
    expect(batchHeader).toHaveLength(17);
    expect(batchHeader[0]).toBe(1);
    expect(batchHeader[4]).toBeNull();
    expect(batchHeader[8]).toEqual([4, 5, 6, 8]);
    expect(batchHeader[16]).toBe(result.generationId);
    expect(header(modelCall, "x-goog-ext-73010989-jspb")).toBe("[0]");
    expect(header(modelCall, "origin")).toBe("https://gemini.google.com");
    expect(header(modelCall, "x-same-domain")).toBe("1");
    expect(header(modelCall, "user-agent")).toBe(GEMINI_WEB_USER_AGENT);
  });

  it("uses explicit slot 0 as /u/0 for both discovery and source-path", async () => {
    const { transport, calls } = bootstrapTransport();
    await bootstrapGeminiWeb({
      cookieHeader: SYNTHETIC_COOKIE,
      authUser: "0",
      transport,
    });

    const modelCall = calls.find((call) => requestUrl(call).searchParams.has("rpcids"));
    expect(requestUrl(modelCall).pathname).toBe("/u/0/_/BardChatUi/data/batchexecute");
    expect(requestUrl(modelCall).searchParams.get("source-path")).toBe("/u/0/app");

    const appCall = calls.find(
      (call) => requestUrl(call).pathname === "/u/0/app" && requestUrl(call).search.includes("hl=en")
    );
    expect(appCall).toBeDefined();
  });

  it("uses the requested nondefault slot and its account path", async () => {
    const { transport, calls } = bootstrapTransport({
      root: () => new Response("primed", { status: 200 }),
      app: () =>
        new Response(BOOTSTRAP_HTML, {
          status: 200,
          headers: { "set-cookie": "__Secure-1PSIDTS=rotated; Domain=.google.com" },
        }),
    });
    await bootstrapGeminiWeb({
      cookieHeader: SYNTHETIC_COOKIE,
      authUser: "2",
      transport,
    });

    const modelCall = calls.find((call) => requestUrl(call).searchParams.has("rpcids"));
    expect(requestUrl(modelCall).pathname).toBe("/u/2/_/BardChatUi/data/batchexecute");
    expect(requestUrl(modelCall).searchParams.get("source-path")).toBe("/u/2/app");
    expect(
      calls.some(
        (call) =>
          requestUrl(call).pathname === "/u/2/app" && requestUrl(call).search.includes("hl=en")
      )
    ).toBe(true);
  });

  it("accepts the fallback array encoding for SNlM0e", async () => {
    const { transport } = bootstrapTransport({
      root: () => new Response("primed", { status: 200 }),
      app: () => new Response(BOOTSTRAP_HTML_FALLBACK_ARRAY, { status: 200 }),
    });
    const result = await bootstrapGeminiWeb({
      cookieHeader: SYNTHETIC_COOKIE,
      authUser: "",
      transport,
    });
    expect(result.at).toBe(SYNTHETIC_AT);
    expect(result.pushId).toBe(GEMINI_WEB_DEFAULT_PUSH_ID);
    expect(result.language).toBe(GEMINI_WEB_DEFAULT_LANGUAGE);
    expect(result.buildLabel).toBe("");
    expect(result.sessionId).toBe("");
  });

  it("fails on HTTP 200 without a signed-in token instead of inferring success", async () => {
    const { transport } = bootstrapTransport({
      app: () => new Response(SIGN_IN_HTML, { status: 200 }),
    });

    const error = await bootstrapGeminiWeb({
      cookieHeader: SYNTHETIC_COOKIE,
      authUser: "",
      transport,
    }).catch((caught) => caught);

    expect(error).toMatchObject({ status: 401 });
    expect(String(error.message)).not.toContain(SYNTHETIC_COOKIE);
    expect(String(error.message)).not.toContain(SYNTHETIC_AT);
  });

  it("never sends the account cookie to a sign-in redirect", async () => {
    const { transport, calls } = bootstrapTransport({
      root: () => new Response("primed", { status: 200 }),
      app: () =>
        redirect("https://accounts.google.com/ServiceLogin?continue=https://gemini.google.com/app"),
    });

    await expect(
      bootstrapGeminiWeb({ cookieHeader: SYNTHETIC_COOKIE, authUser: "2", transport })
    ).rejects.toMatchObject({ status: 401 });

    expect(calls.some((call) => requestUrl(call).origin === "https://accounts.google.com")).toBe(
      false
    );
    expect(header(calls[calls.length - 1], "cookie")).toContain("__Secure-1PSID");
  });

  it("fails verification when the requested slot is redirected to root or another slot", async () => {
    for (const location of ["/app", "/u/0/app", "/u/3/app"]) {
      const { transport } = bootstrapTransport({
        app: (call, callNumber) =>
          callNumber === 1 ? redirect(location) : new Response(BOOTSTRAP_HTML, { status: 200 }),
      });
      await expect(
        bootstrapGeminiWeb({ cookieHeader: SYNTHETIC_COOKIE, authUser: "2", transport })
      ).rejects.toMatchObject({ status: 400 });
    }
  });

  it("refuses redirects that leave the Gemini origin or exceed five hops", async () => {
    const foreign = bootstrapTransport({
      root: () => new Response("primed", { status: 200 }),
      app: () => redirect("https://gemini.google.com.evil.example/app"),
    });
    await expect(
      bootstrapGeminiWeb({ cookieHeader: SYNTHETIC_COOKIE, authUser: "", transport: foreign.transport })
    ).rejects.toMatchObject({ status: 502 });

    const loop = bootstrapTransport({
      root: () => new Response("primed", { status: 200 }),
      app: () => redirect("/app?loop=1"),
    });
    await expect(
      bootstrapGeminiWeb({ cookieHeader: SYNTHETIC_COOKIE, authUser: "", transport: loop.transport })
    ).rejects.toMatchObject({ status: 502 });
    expect(loop.calls.length).toBeLessThanOrEqual(8);
  });

  it("preserves upstream 401/403/429 status and Retry-After without leaking secrets", async () => {
    for (const status of [401, 403, 429]) {
      const { transport } = bootstrapTransport({
        root: () => new Response("primed", { status: 200 }),
        app: () =>
          new Response("upstream rejected", {
            status,
            headers: { "retry-after": "7" },
          }),
      });
      const error = await bootstrapGeminiWeb({
        cookieHeader: SYNTHETIC_COOKIE,
        authUser: "",
        transport,
      }).catch((caught) => caught);
      expect(error.status).toBe(status);
      expect(error.retryAfter).toBe(7);
      expect(String(error.message)).not.toContain("synthetic-psid");
      expect(String(error.message)).not.toContain(SYNTHETIC_AT);
    }
  });

  it("rejects an aborted bootstrap before any network request", async () => {
    const { transport, calls } = bootstrapTransport();
    const controller = new AbortController();
    controller.abort();

    await expect(
      bootstrapGeminiWeb({
        cookieHeader: SYNTHETIC_COOKIE,
        authUser: "",
        signal: controller.signal,
        transport,
      })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toHaveLength(0);
  });
});

describe("Gemini Web model discovery", () => {
  it("reads account model identity, capacity and number from length-prefixed RPC frames", () => {
    const body = lengthPrefixedBody([
      [["wrb.fr", "other-rpc", "[]"]],
      modelStatusFixture({
        tiers: [8],
        entries: [
          modelEntry("account-flash-id", "Fast", "Gemini 3.8 Flash", 1),
          modelEntry("account-pro-id", "Pro", "Gemini 3.1 Pro", 3),
        ],
      }),
    ]);
    const { models, skipped } = parseGeminiModels(body);

    expect(skipped).toEqual([]);
    expect(models).toEqual([
      {
        id: "gemini-3.8-flash",
        name: "Gemini 3.8 Flash",
        modelId: "account-flash-id",
        modelNumber: 1,
        capacity: 2,
        capacityField: 12,
      },
      {
        id: "gemini-3.1-pro",
        name: "Gemini 3.1 Pro",
        modelId: "account-pro-id",
        modelNumber: 3,
        capacity: 2,
        capacityField: 12,
      },
    ]);
  });

  it.each([
    { name: "free", tiers: null, capabilities: null, capacity: 1, field: 12 },
    { name: "pro tier", tiers: [8], capabilities: null, capacity: 2, field: 12 },
    { name: "pro capability", tiers: null, capabilities: [19], capacity: 2, field: 12 },
    { name: "alternate pro tier", tiers: [16, 8], capabilities: null, capacity: 3, field: 12 },
    { name: "alternate pro capability", tiers: null, capabilities: [106, 19], capacity: 3, field: 12 },
    { name: "plus precedence", tiers: [16], capabilities: [115, 19], capacity: 4, field: 12 },
    { name: "field 13 first override", tiers: [21, 22, 16], capabilities: [115], capacity: 1, field: 13 },
    { name: "field 13 second override", tiers: [22, 8], capabilities: [115], capacity: 2, field: 13 },
  ])("derives $name capacity from account flags", ({ tiers, capabilities, capacity, field }) => {
    const { models } = parseGeminiModels(
      modelDiscoveryBody({
        tiers,
        capabilities,
        entries: [modelEntry("id", "Pro", "Pro", 3)],
      })
    );
    expect(models[0].capacity).toBe(capacity);
    expect(models[0].capacityField).toBe(field);
  });

  it("reads alternate RPC fields, defaults an omitted model number to one, and skips duplicates", () => {
    const alternate = modelEntry("alternate-id", "", "", undefined);
    alternate[9] = 3;
    alternate[10] = "Pro";
    alternate[19] = "Gemini 3 Pro";
    const duplicate = modelEntry("alternate-id", "Pro", "Duplicate", 3);
    const { models, skipped } = parseGeminiModels(
      modelDiscoveryBody({ entries: [alternate, duplicate] })
    );

    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: "gemini-3-pro",
      modelId: "alternate-id",
      modelNumber: 3,
    });
    expect(skipped[0]).toMatch(/^duplicate model ID: /);
  });

  it.each(["", "<html>gemini-pro gemini-flash</html>", '[["wrb.fr","another-rpc","[]"]]', '[["wrb.fr","otAQ7b",null]]', '[["wrb.fr","otAQ7b","not json"]]'])(
    "fails explicitly for malformed or empty discovery",
    (body) => {
      expect(() => parseGeminiModels(body)).toThrowError(
        expect.objectContaining({ status: 502 })
      );
    }
  );

  it("rejects unavailable account sessions and rejected RPC codes", () => {
    for (const statusCode of [1014, 1016, 1021, 1033, 1040, 1042, 1054, 1057, 1060, 9999]) {
      expect(() =>
        parseGeminiModels(
          modelDiscoveryBody({
            statusCode,
            entries: [modelEntry("flash-id", "Flash", "Flash", 1)],
          })
        )
      ).toThrowError(expect.objectContaining({ status: 502 }));
    }

    expect(() =>
      parseGeminiModels(
        lengthPrefixedBody([
          [["wrb.fr", "otAQ7b", JSON.stringify(new Array(18)), null, null, [7]]],
        ])
      )
    ).toThrowError(expect.objectContaining({ status: 502 }));
  });

  it("rejects invalid model numbers and reports the skipped entries", () => {
    for (const number of [0, -1, "3", 3.5, false]) {
      const error = (() => {
        try {
          parseGeminiModels(
            modelDiscoveryBody({ entries: [modelEntry("pro-id", "Pro", "Pro", number)] })
          );
          return null;
        } catch (caught) {
          return caught;
        }
      })();
      expect(error).toMatchObject({ status: 502 });
      expect(String(error.message)).toContain("invalid model number");
      expect(String(error.message)).toContain("pro-id");
    }

    const { models } = parseGeminiModels(
      modelDiscoveryBody({ entries: [modelEntry("flash-id", "Flash", "Flash", undefined)] })
    );
    expect(models[0].modelNumber).toBe(1);
  });

  it("sends the authenticated otAQ7b RPC with the account slot and batch headers", async () => {
    const { transport, calls } = createTransport(() =>
      jsonBody(
        modelDiscoveryBody({
          tiers: [8],
          entries: [modelEntry("account-pro", "Pro", "Gemini 3 Pro", 3)],
        })
      )
    );

    const models = await fetchGeminiWebModels(BASE_SESSION, {
      authUser: "2",
      transport,
      proxyOptions: { enabled: false },
    });

    expect(models).toHaveLength(1);
    expect(models[0].modelId).toBe("account-pro");
    const call = calls[0];
    const url = requestUrl(call);
    expect(call.options.method).toBe("POST");
    expect(url.pathname).toBe("/u/2/_/BardChatUi/data/batchexecute");
    expect(url.searchParams.get("rpcids")).toBe("otAQ7b");
    expect(url.searchParams.get("hl")).toBe("en");
    expect(url.searchParams.get("rt")).toBe("c");
    expect(url.searchParams.get("source-path")).toBe("/u/2/app");
    expect(url.searchParams.get("bl")).toBe(SYNTHETIC_BUILD);
    expect(url.searchParams.get("f.sid")).toBe(SYNTHETIC_GOOGLE_SESSION);
    expect(Number(url.searchParams.get("_reqid"))).toBeGreaterThanOrEqual(10000);
    expect(formOf(call).get("at")).toBe(SYNTHETIC_AT);
    expect(formOf(call).get("f.req")).toBe('[[["otAQ7b","[]",null,"generic"]]]');
    expect(header(call, "cookie")).toBe(SYNTHETIC_COOKIE);
    expect(header(call, "content-type")).toBe(
      "application/x-www-form-urlencoded;charset=utf-8"
    );
    expect(header(call, "origin")).toBe("https://gemini.google.com");
    expect(header(call, "referer")).toBe("https://gemini.google.com/");
    expect(header(call, "x-same-domain")).toBe("1");
    expect(header(call, "user-agent")).toBe(GEMINI_WEB_USER_AGENT);
    expect(header(call, "x-goog-ext-73010989-jspb")).toBe("[0]");
    expect(call.options.redirect).toBe("manual");
    expect(call.options.strictTls).toBe(true);
    expect(call.options.maxHeaderSize).toBe(GEMINI_WEB_LIMITS.maxHeaderSize);
    expect(call.proxyOptions.strictProxy).toBe(true);
  });

  it("preserves upstream status codes without exposing session values", async () => {
    for (const status of [401, 403, 500]) {
      const { transport } = createTransport(
        () => new Response("secret-response", { status })
      );
      const error = await fetchGeminiWebModels(BASE_SESSION, { transport }).catch(
        (caught) => caught
      );
      expect(error.status).toBe(status === 500 ? 502 : status);
      expect(String(error.message)).not.toContain("secret-response");
      expect(String(error.message)).not.toContain(SYNTHETIC_COOKIE);
    }
  });

  it("bounds a model discovery response at eight MiB", async () => {
    const oversized = new ReadableStream({
      start(controller) {
        const chunk = new Uint8Array(1024 * 1024).fill(0x61);
        for (let index = 0; index < 9; index += 1) controller.enqueue(chunk);
        controller.close();
      },
    });
    const { transport } = createTransport(
      () => new Response(oversized, { status: 200 })
    );
    await expect(fetchGeminiWebModels(BASE_SESSION, { transport })).rejects.toMatchObject({
      status: 502,
    });
  });

  it("never substitutes or invents a model", () => {
    const models = [
      {
        id: "gemini-3.8-flash",
        name: "Gemini 3.8 Flash",
        modelId: "flash-id",
        modelNumber: 1,
        capacity: 1,
        capacityField: 12,
      },
    ];

    expect(resolveGeminiModel("gemini-3.8-flash", models)).toEqual(models[0]);
    expect(resolveGeminiModel("flash-id", models)).toEqual(models[0]);
    for (const requested of [
      "gemini-pro",
      "gemini-advanced",
      "gemini-3-pro-image-preview",
      "gemini-3.1-flash-image-preview",
      "",
    ]) {
      expect(() => resolveGeminiModel(requested, models)).toThrowError(
        expect.objectContaining({ status: 404 })
      );
    }
  });
});

describe("Gemini Web policy-code models", () => {
  it("promotes GetUserStatus policy overlay entries that have no hex routing id", () => {
    const { models, skipped } = parseGeminiModels(
      modelDiscoveryBody({
        tiers: [8],
        entries: [modelEntry("account-flash-id", "Fast", "Gemini 3.8 Flash", 1)],
        policy: [
          "carbon_multi_ultra_pro_policy",
          [
            policyGroup("", "4 Hydrogen", "Everyday help", 1),
            policyGroup("argon", "Argon", "Code & analysis", 8),
          ],
        ],
      })
    );

    expect(skipped).toEqual([]);
    expect(models).toEqual([
      {
        id: "gemini-3.8-flash",
        name: "Gemini 3.8 Flash",
        modelId: "account-flash-id",
        modelNumber: 1,
        capacity: 2,
        capacityField: 12,
      },
      {
        id: "gemini-code-analysis",
        name: "Code & analysis",
        modelId: "argon",
        modelNumber: 8,
        capacity: 2,
        capacityField: 12,
        policy: true,
      },
    ]);
    expect(resolveGeminiModel("argon", models).id).toBe("gemini-code-analysis");
    expect(resolveGeminiModel("code & analysis", models).modelId).toBe("argon");
  });

  it("encodes the captured Argon req1 prompt protobuf", () => {
    expect(protoToBase64(encodeProcessSessionReq1("ping"))).toBe("EgoIAUoGCgRwaW5n");
  });

  it("encodes req0 with argon, model number 8, and thinking 1", () => {
    const bytes = encodeProcessSessionReq0({
      modelId: "argon",
      language: "en",
      generationId: SYNTHETIC_GENERATION_ID,
      requestId: SYNTHETIC_GENERATION_ID,
      modelNumber: 8,
      thinkingLevel: 1,
    });
    const text = Buffer.from(bytes).toString("utf8");
    expect(text).toContain("argon");
    expect(text).toContain(SYNTHETIC_GENERATION_ID);
    expect(text).not.toContain("StreamGenerate");
  });

  it("sends policy-code models through ProcessSession instead of StreamGenerate", async () => {
    const { transport, calls } = createTransport((call) => {
      const url = new URL(call.url);
      if (!url.pathname.includes("processSession")) {
        return new Response("unexpected", { status: 500 });
      }
      const body = String(call.options.body || "");
      if (body === "count=0" || body.startsWith("count=0")) {
        return new Response('[[0,["c","synthetic-sid","0",8]]]', {
          status: 200,
          headers: { "x-http-session-id": "synthetic-gsession" },
        });
      }
      return new Response(streamBodyFromAnswerText("pong"), { status: 200 });
    });

    const result = await generateGeminiWeb({
      session: BASE_SESSION,
      authUser: "9",
      model: ARGON_MODEL,
      prompt: "ping",
      thinkingLevel: "low",
      transport,
    });

    expect(result.ok).toBe(true);
    expect(calls.some((call) => call.url.includes("StreamGenerate"))).toBe(false);
    expect(calls.some((call) => call.url.includes("/v1/processSession"))).toBe(true);
    const send = calls.find((call) => String(call.options.body || "").includes("req1___data__"));
    expect(send).toBeTruthy();
    const form = new URLSearchParams(send.options.body);
    expect(form.get("count")).toBe("2");
    expect(form.get("ofs")).toBe("0");
    expect(form.get("req1___data__")).toBe("EgoIAUoGCgRwaW5n");
    const req0 = Buffer.from(form.get("req0___data__"), "base64").toString("utf8");
    expect(req0).toContain("argon");
    expect(new URL(send.url).searchParams.get("authuser")).toBe("9");
    expect(new URL(send.url).searchParams.get("gsessionid")).toBe("synthetic-gsession");
    expect(new URL(send.url).searchParams.get("SID")).toBe("synthetic-sid");
    expect(calls.some((call) => call.url.includes("waa-pa"))).toBe(false);
    const events = await collect(decodeGeminiWebStream(result.body));
    expect(events.some((event) => event.type === "text" && event.text.includes("pong"))).toBe(true);
  });

  it("reads the Bind answer from the rpc GET when the send ACK is only XSSI", async () => {
    const { transport } = createTransport((call) => {
      const url = new URL(call.url);
      if (!url.pathname.includes("processSession")) {
        return new Response("unexpected", { status: 500 });
      }
      const body = String(call.options.body || "");
      if (body === "count=0" || body.startsWith("count=0")) {
        return new Response('[[0,["c","synthetic-sid","0",8]]]', {
          status: 200,
          headers: { "x-http-session-id": "synthetic-gsession" },
        });
      }
      if (call.options.method === "GET" || url.searchParams.get("RID") === "rpc") {
        return new Response(streamBodyFromAnswerText("pong"), { status: 200 });
      }
      return new Response(")]}'\n[[1,[]]]\n", { status: 200 });
    });

    const result = await generateGeminiWeb({
      session: BASE_SESSION,
      authUser: "9",
      model: ARGON_MODEL,
      prompt: "ping",
      thinkingLevel: "low",
      transport,
    });

    expect(result.ok).toBe(true);
    const events = await collect(decodeGeminiWebStream(result.body));
    expect(events.some((event) => event.type === "text" && event.text.includes("pong"))).toBe(true);
  });

  it("returns a Bind answer without waiting for the rpc GET to close", async () => {
    const { transport } = createTransport((call) => {
      const url = new URL(call.url);
      if (!url.pathname.includes("processSession")) {
        return new Response("unexpected", { status: 500 });
      }
      const body = String(call.options.body || "");
      if (body === "count=0" || body.startsWith("count=0")) {
        return new Response('[[0,["c","synthetic-sid","0",8]]]', {
          status: 200,
          headers: { "x-http-session-id": "synthetic-gsession" },
        });
      }
      if (call.options.method === "GET" || url.searchParams.get("RID") === "rpc") {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(streamBodyFromAnswerText("pong")));
            },
          }),
          { status: 200 }
        );
      }
      return new Response(")]}'\n[[1,[]]]\n", { status: 200 });
    });

    const result = await generateGeminiWeb({
      session: BASE_SESSION,
      authUser: "9",
      model: ARGON_MODEL,
      prompt: "ping",
      thinkingLevel: "low",
      transport,
    });

    expect(result.ok).toBe(true);
    const events = await collect(decodeGeminiWebStream(result.body));
    expect(events.some((event) => event.type === "text" && event.text.includes("pong"))).toBe(true);
  }, 2000);

  // Bind responses are length-prefixed JSON records whose payload is base64
  // protobuf. Shapes below follow a captured Argon turn: turn.1 and
  // candidate.15 carry completion, candidate.11 is a progress label, and
  // candidate.27 -> 1 -> 2 -> 3 is the answer text.
  function bindVarint(value) {
    const bytes = [];
    let rest = value >>> 0;
    while (rest > 0x7f) {
      bytes.push((rest & 0x7f) | 0x80);
      rest >>>= 7;
    }
    bytes.push(rest);
    return bytes;
  }

  function bindBytesField(field, payload) {
    return [...bindVarint((field << 3) | 2), ...bindVarint(payload.length), ...payload];
  }

  function bindNumberField(field, value) {
    return [...bindVarint((field << 3) | 0), ...bindVarint(value)];
  }

  function bindStringField(field, text) {
    return bindBytesField(field, [...new TextEncoder().encode(text)]);
  }

  function bindCandidate({ text = "", label = "", final = false }) {
    const candidate = [];
    if (label) candidate.push(...bindStringField(11, label));
    candidate.push(...bindNumberField(15, final && text ? 1 : 0));
    if (text) {
      const slots = [...bindNumberField(2, 0), ...bindStringField(3, text)];
      candidate.push(...bindBytesField(27, bindBytesField(1, bindBytesField(2, slots))));
    }
    return candidate;
  }

  function bindTurn({ text, label, final }) {
    const turn = [
      ...bindNumberField(1, final ? 1 : 0),
      ...bindBytesField(4, bindBytesField(4, bindCandidate({ text, label, final }))),
    ];
    const envelope = [...bindNumberField(1, 3), ...bindBytesField(7, bindBytesField(1, turn))];
    return bindBytesField(2, envelope);
  }

  function bindBody(frames) {
    return frames
      .map((frame, index) => {
        const payload = Buffer.from(bindTurn(frame)).toString("base64");
        const record = JSON.stringify([[index + 1, [payload]]]);
        return `${Buffer.byteLength(record)}\n${record}\n`;
      })
      .join("");
  }

  function bindTransport({ rpc }) {
    return createTransport((call) => {
      const url = new URL(call.url);
      if (!url.pathname.includes("processSession")) {
        return new Response("unexpected", { status: 500 });
      }
      const body = String(call.options.body || "");
      if (body === "count=0" || body.startsWith("count=0")) {
        return new Response('[[0,["c","synthetic-sid","0",8]]]', {
          status: 200,
          headers: { "x-http-session-id": "synthetic-gsession" },
        });
      }
      if (call.options.method === "GET" || url.searchParams.get("RID") === "rpc") {
        return rpc(call);
      }
      return new Response(")]}'\n[[1,[]]]\n", { status: 200 });
    });
  }

  async function bindEvents(rpc) {
    const { transport } = bindTransport({ rpc });
    const result = await generateGeminiWeb({
      session: BASE_SESSION,
      authUser: "9",
      model: ARGON_MODEL,
      prompt: "ping",
      thinkingLevel: "low",
      transport,
    });
    expect(result.ok).toBe(true);
    return collect(decodeGeminiWebStream(result.body));
  }

  it("completes at the turn's own completion flag without waiting for the channel to close", async () => {
    let cancelled = false;
    const body = bindBody([
      { text: "Working directory: /" },
      { text: "Working directory: /app", final: true },
      { label: "Setting Working Directory To App" },
    ]);
    const events = await bindEvents(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(body));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200 }
        )
    );

    const text = events.filter((event) => event.type === "text").map((event) => event.text).join("");
    expect(text).toBe("Working directory: /app");
    expect(cancelled).toBe(true);
  }, 3000);

  it("does not settle on a partial turn while the channel is open, and rejects it at EOF", async () => {
    const encoder = new TextEncoder();
    let source;
    const stream = new ReadableStream({
      start(controller) {
        source = controller;
      },
    });
    const pending = readBindUntilAnswer(new Response(stream));
    let settled = false;
    void pending.catch(() => {
      settled = true;
    });

    source.enqueue(encoder.encode(bindBody([{ text: "Working" }])));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(settled).toBe(false);

    source.close();
    const error = await pending.catch((caught) => caught);
    expect(error).toMatchObject({ status: 502 });
    expect(String(error.message)).toContain("ended before the turn reported completion");
  }, 3000);

  it("maps a pre-answer Bind label to reasoning and never to answer text", async () => {
    const events = await bindEvents(
      () =>
        new Response(
          bindBody([
            { label: "Setting Working Directory To App" },
            { text: "Working directory: /app", final: true },
          ]),
          { status: 200 }
        )
    );

    expect(
      events.some(
        (event) => event.type === "reasoning" && event.text.includes("Setting Working Directory To App")
      )
    ).toBe(true);
    const text = events.filter((event) => event.type === "text").map((event) => event.text).join("");
    expect(text).toBe("Working directory: /app");
  }, 3000);

  it("never fabricates an answer from a Bind stream that only carries labels", async () => {
    const { transport } = bindTransport({
      rpc: () => new Response(bindBody([{ label: "Thinking" }]), { status: 200 }),
    });

    const error = await generateGeminiWeb({
      session: BASE_SESSION,
      authUser: "9",
      model: ARGON_MODEL,
      prompt: "ping",
      thinkingLevel: "low",
      transport,
    }).catch((caught) => caught);

    expect(error).toMatchObject({ status: 502 });
    expect(String(error?.message)).toContain("ended before the turn reported completion");
  }, 3000);

  it("keeps the later cumulative Bind answer instead of the first partial frame", async () => {
    const encoder = new TextEncoder();
    const events = await bindEvents(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(bindBody([{ text: "partial" }])));
              setTimeout(() => {
                controller.enqueue(
                  encoder.encode(bindBody([{ text: "partial" }, { text: "partial answer plus more", final: true }]))
                );
              }, 30);
            },
          }),
          { status: 200 }
        )
    );

    const text = events.filter((event) => event.type === "text").map((event) => event.text).join("");
    expect(text).toBe("partial answer plus more");
  }, 3000);

  it("never completes on a Bind frame that is still split across reads", async () => {
    const bytes = new TextEncoder().encode(
      bindBody([{ text: "Working directory: /app", final: true }])
    );
    const middle = Math.floor(bytes.length / 2);
    const events = await bindEvents(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(bytes.slice(0, middle));
              setTimeout(() => {
                controller.enqueue(bytes.slice(middle));
                controller.close();
              }, 20);
            },
          }),
          { status: 200 }
        )
    );

    const text = events.filter((event) => event.type === "text").map((event) => event.text).join("");
    expect(text).toBe("Working directory: /app");
  }, 3000);

  it("never completes on a raw wrb frame that is still split across reads", async () => {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(streamBodyFromAnswerText("pong"));
    const middle = Math.floor(bytes.length / 2);
    const events = await bindEvents(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(bytes.slice(0, middle));
              setTimeout(() => {
                controller.enqueue(bytes.slice(middle));
                controller.close();
              }, 30);
            },
          }),
          { status: 200 }
        )
    );

    const text = events.filter((event) => event.type === "text").map((event) => event.text).join("");
    expect(text).toBe("pong");
  }, 3000);

  it("never invents answer text from a labels-only stream", async () => {
    const { transport } = bindTransport({
      rpc: () => new Response(bindBody([{ label: "Thinking" }]), { status: 200 }),
    });

    const error = await generateGeminiWeb({
      session: BASE_SESSION,
      authUser: "9",
      model: ARGON_MODEL,
      prompt: "ping",
      thinkingLevel: "low",
      transport,
    }).catch((caught) => caught);

    expect(error).toMatchObject({ status: 502 });
    expect(String(error?.message)).toContain("ended before the turn reported completion");
  }, 3000);

  it("keeps the literal completed answer when later records carry other text", async () => {
    const completed = ARGON_BIND_RECORDS.filter((record) => record.sequence === 8);
    const body = argonBindBody(completed) + bindBody([{ text: "Working directory: /app but later" }]);

    expect(extractProcessSessionAnswer(body)).toBe(ARGON_BIND_FINAL_TEXT);

    const streamBody = await readBindUntilAnswer(new Response(body)).catch((caught) => caught);
    expect(typeof streamBody).toBe("string");
    const events = await collect(decodeGeminiWebStream(new Response(streamBody).body));
    const text = events.filter((event) => event.type === "text").map((event) => event.text).join("");
    expect(text).toBe(ARGON_BIND_FINAL_TEXT);
  }, 3000);

  it("keeps the first completed answer when a second turn also completes", () => {
    const completed = ARGON_BIND_RECORDS.filter((record) => record.sequence === 8);
    const body =
      argonBindBody(completed) + bindBody([{ text: "A different later answer", final: true }]);

    expect(extractProcessSessionAnswer(body)).toBe(ARGON_BIND_FINAL_TEXT);
  });

  it("decodes the literal captured Bind records to the captured answer", async () => {
    const body = argonBindBody();

    expect(extractProcessSessionAnswer(body)).toBe(ARGON_BIND_FINAL_TEXT);

    const streamBody = await readBindUntilAnswer(new Response(body));
    const events = await collect(decodeGeminiWebStream(new Response(streamBody).body));
    const text = events.filter((event) => event.type === "text").map((event) => event.text).join("");
    expect(text).toBe(ARGON_BIND_FINAL_TEXT);
  }, 3000);

  it("reads the literal captured partial record without treating it as the answer", () => {
    const partialOnly = argonBindBody(ARGON_BIND_RECORDS.filter((record) => record.sequence === 5));

    expect(extractProcessSessionAnswer(partialOnly)).toBe("");
    expect(ARGON_BIND_PARTIAL_TEXT).toBe("Working directory: /");
  });

  it("rejects a typed Bind stream that ends after a partial answer", async () => {
    const partialOnly = argonBindBody(ARGON_BIND_RECORDS.filter((record) => record.sequence === 5));

    const body = await readBindUntilAnswer(new Response(partialOnly)).catch((caught) => caught);
    expect(body).toMatchObject({ status: 502 });
    expect(String(body.message)).toContain("ended before the turn reported completion");
  }, 3000);

  it("rejects EOF on a partial typed turn instead of streaming its prefix", async () => {
    const encoder = new TextEncoder();
    const partialOnly = argonBindBody(ARGON_BIND_RECORDS.filter((record) => record.sequence === 5));
    const harness = bindTransport({
      rpc: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(partialOnly));
              controller.close();
            },
          }),
          { status: 200 }
        ),
    });

    const error = await generateGeminiWeb({
      session: BASE_SESSION,
      authUser: "9",
      model: ARGON_MODEL,
      prompt: "ping",
      thinkingLevel: "low",
      transport: harness.transport,
    }).catch((caught) => caught);

    expect(error).toMatchObject({ status: 502 });
    expect(String(error.message)).toContain("ended before the turn reported completion");
  }, 3000);

  it("returns no answer for a heartbeat-only Bind body", async () => {
    const body = await readBindUntilAnswer(new Response('14\n[[1,["noop"]]]14\n[[2,["CgA="]]]\n'));
    expect(body).toBe("");
  }, 3000);

  it("stops a Bind read when the caller aborts before the turn completes", async () => {
    let cancelled = false;
    const { transport } = bindTransport({
      rpc: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(bindBody([{ text: "Working on it" }])));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200 }
        ),
    });
    const controller = new AbortController();
    const pending = generateGeminiWeb({
      session: BASE_SESSION,
      authUser: "9",
      model: ARGON_MODEL,
      prompt: "ping",
      thinkingLevel: "low",
      signal: controller.signal,
      transport,
    }).catch((caught) => caught);

    // An unfinished turn has no completion flag, so the read must still be
    // waiting rather than settling on the partial text.
    const settled = await Promise.race([
      pending.then(() => "settled"),
      new Promise((resolve) => setTimeout(() => resolve("waiting"), 400)),
    ]);
    expect(settled).toBe("waiting");

    controller.abort(new Error("client cancelled"));
    const error = await pending;
    expect(error?.name).toBe("AbortError");
    expect(cancelled).toBe(true);
  }, 3000);

  it("passes structural Bind labels through as reasoning beside the answer", async () => {
    const events = await bindEvents(
      () =>
        new Response(lengthPrefixedBody([labelFrame("Thinking"), answerFrame("pong")]), {
          status: 200,
        })
    );

    expect(events.some((event) => event.type === "reasoning" && event.text.includes("Thinking"))).toBe(
      true
    );
    const text = events.filter((event) => event.type === "text").map((event) => event.text).join("");
    expect(text).toBe("pong");
  }, 3000);



  it("parses a BrowserChannel open reply and Bind answer text", () => {
    expect(parseBrowserChannelOpen('[[0,["c","sid-a","0",8]]]')).toEqual({
      sid: "sid-a",
    });
    expect(extractProcessSessionAnswer(streamBodyFromAnswerText("pong"))).toContain("wrb.fr");
  });
});


describe("Gemini Web generation wire contract", () => {
  function generateTransport() {
    return createTransport(() => new Response("ok", { status: 200 }));
  }

  it("builds the 81-element inner payload with model, thinking and uploaded files", async () => {
    const { transport, calls } = generateTransport();
    const result = await generateGeminiWeb({
      session: BASE_SESSION,
      authUser: "2",
      model: FLASH_MODEL,
      prompt: "Describe",
      files: [{ id: "uploaded-id", name: "image.png" }],
      thinkingLevel: "medium",
      proxyOptions: { enabled: false },
      transport,
    });

    expect(result.status).toBe(200);
    expect(await result.text()).toBe("ok");
    const call = calls[0];
    const url = requestUrl(call);
    expect(url.pathname).toBe(
      "/u/2/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate"
    );
    expect(url.searchParams.get("at")).toBe(SYNTHETIC_AT);
    expect(url.searchParams.get("hl")).toBe("en");
    expect(url.searchParams.get("rt")).toBe("c");
    expect(url.searchParams.get("bl")).toBe(SYNTHETIC_BUILD);
    expect(url.searchParams.get("f.sid")).toBe(SYNTHETIC_GOOGLE_SESSION);
    expect(Number(url.searchParams.get("_reqid"))).toBeGreaterThanOrEqual(10000);

    expect(call.options.method).toBe("POST");
    expect(header(call, "content-type")).toBe(
      "application/x-www-form-urlencoded;charset=utf-8"
    );
    expect(header(call, "origin")).toBe("https://gemini.google.com");
    expect(header(call, "referer")).toBe("https://gemini.google.com/");
    expect(header(call, "x-same-domain")).toBe("1");
    expect(header(call, "user-agent")).toBe(GEMINI_WEB_USER_AGENT);
    expect(header(call, "cookie")).toBe(SYNTHETIC_COOKIE);
    expect(call.options.redirect).toBe("manual");
    expect(call.options.strictTls).toBe(true);
    expect(call.options.maxHeaderSize).toBe(GEMINI_WEB_LIMITS.maxHeaderSize);
    expect(call.options.forceFreshSocket).toBe(true);
    expect(call.proxyOptions.strictProxy).toBe(true);

    const outer = JSON.parse(formOf(call).get("f.req"));
    expect(outer).toHaveLength(2);
    expect(outer[0]).toBeNull();
    const inner = JSON.parse(outer[1]);
    expect(inner).toHaveLength(81);
    expect(inner[0]).toEqual([
      "Describe",
      0,
      null,
      [[["uploaded-id"], "image.png"]],
      null,
      null,
      0,
    ]);
    expect(inner[1]).toEqual(["en"]);
    expect(inner[2]).toEqual(["", "", "", null, null, null, null, null, null, ""]);
    expect(inner[79]).toBe(FLASH_MODEL.modelNumber);
    expect(inner[80]).toBe(4);

    const modelHeader = JSON.parse(header(call, GEMINI_WEB_MODEL_HEADER));
    expect(modelHeader).toHaveLength(17);
    expect(modelHeader[0]).toBe(1);
    expect(modelHeader[4]).toBe(FLASH_MODEL.modelId);
    expect(modelHeader[7]).toBe(0);
    expect(modelHeader[8]).toEqual([4, 5, 6, 8]);
    expect(modelHeader[11]).toBe(FLASH_MODEL.capacity);
    expect(modelHeader[14]).toBe(FLASH_MODEL.modelNumber);
    expect(modelHeader[15]).toBe(4);
    expect(modelHeader[16]).toBe(SYNTHETIC_GENERATION_ID);

    const requestHeader = JSON.parse(header(call, "x-goog-ext-525005358-jspb"));
    expect(requestHeader).toHaveLength(2);
    expect(requestHeader[0]).toBe(inner[59]);
    expect(requestHeader[1]).toBe(1);
    expect(header(call, "x-goog-ext-73010989-jspb")).toBe("[0]");
    expect(header(call, "x-goog-ext-73010990-jspb")).toBe("[0,0,0]");
  });

  it("supports the alternate capacity-field header layout", async () => {
    const { transport, calls } = generateTransport();
    const model = { ...FLASH_MODEL, capacityField: 13, capacity: 3, modelNumber: 2 };
    await generateGeminiWeb({
      session: BASE_SESSION,
      authUser: "",
      model,
      prompt: "Hello",
      thinkingLevel: "high",
      transport,
    });

    const call = calls[0];
    expect(requestUrl(call).pathname).toBe(
      "/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate"
    );
    const modelHeader = JSON.parse(header(call, GEMINI_WEB_MODEL_HEADER));
    expect(modelHeader).toHaveLength(18);
    expect(modelHeader[12]).toBe(3);
    expect(modelHeader[15]).toBe(2);
    expect(modelHeader[16]).toBe(2);
    expect(modelHeader[17]).toBe(SYNTHETIC_GENERATION_ID);
  });

  it.each([
    { level: undefined, wire: 1 },
    { level: "", wire: 1 },
    { level: "auto", wire: 1 },
    { level: "low", wire: 1 },
    { level: "medium", wire: 4 },
    { level: "high", wire: 2 },
    { level: " HIGH ", wire: 2 },
    { level: 1, wire: 1 },
    { level: 4, wire: 4 },
    { level: 2, wire: 2 },
  ])("maps thinking intent $level to wire enum $wire", async ({ level, wire }) => {
    const { transport, calls } = generateTransport();
    await generateGeminiWeb({
      session: BASE_SESSION,
      authUser: "",
      model: FLASH_MODEL,
      prompt: "Hello",
      thinkingLevel: level,
      transport,
    });

    const call = calls[0];
    const outer = JSON.parse(formOf(call).get("f.req"));
    const inner = JSON.parse(outer[1]);
    expect(inner[80]).toBe(wire);
    const modelHeader = JSON.parse(header(call, GEMINI_WEB_MODEL_HEADER));
    expect(modelHeader[15]).toBe(wire);
  });

  it.each(["none", "off", "minimal", "xhigh", "deep_think", "invalid", 0, 8192, -1, true, false])(
    "rejects unsupported thinking control %s with a 400 compatibility error",
    async (level) => {
      const { transport, calls } = generateTransport();
      const error = await generateGeminiWeb({
        session: BASE_SESSION,
        authUser: "",
        model: FLASH_MODEL,
        prompt: "Hello",
        thinkingLevel: level,
        transport,
      }).catch((caught) => caught);

      expect(error).toMatchObject({
        status: 400,
        code: "unsupported_control_for_provider",
      });
      expect(calls).toHaveLength(0);
    }
  );

  it("issues a fresh request UUID per call while keeping the bootstrap generation ID", async () => {
    const { transport, calls } = generateTransport();
    for (let index = 0; index < 2; index += 1) {
      await generateGeminiWeb({
        session: BASE_SESSION,
        authUser: "",
        model: FLASH_MODEL,
        prompt: "Hello",
        transport,
      });
    }

    const ids = calls.map((call) => {
      const outer = JSON.parse(formOf(call).get("f.req"));
      const inner = JSON.parse(outer[1]);
      return {
        requestId: inner[59],
        generationId: JSON.parse(header(call, GEMINI_WEB_MODEL_HEADER))[16],
        headerRequestId: JSON.parse(header(call, "x-goog-ext-525005358-jspb"))[0],
      };
    });

    expect(ids[0].requestId).toMatch(/^[0-9A-F-]{36}$/);
    expect(ids[1].requestId).not.toBe(ids[0].requestId);
    expect(ids[0].generationId).toBe(SYNTHETIC_GENERATION_ID);
    expect(ids[1].generationId).toBe(SYNTHETIC_GENERATION_ID);
    expect(ids[0].headerRequestId).toBe(ids[0].requestId);
    expect(ids[1].headerRequestId).toBe(ids[1].requestId);
  });

  it("returns an upstream 429 response with Retry-After unchanged", async () => {
    const { transport } = createTransport(
      () =>
        new Response("slow down", {
          status: 429,
          headers: { "retry-after": "9" },
        })
    );
    const response = await generateGeminiWeb({
      session: BASE_SESSION,
      authUser: "",
      model: FLASH_MODEL,
      prompt: "Hello",
      transport,
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("9");
  });

  it("turns an unexpected generation redirect into a sanitized 502", async () => {
    const { transport } = createTransport(
      () => redirect("https://evil.example/collect")
    );
    const error = await generateGeminiWeb({
      session: BASE_SESSION,
      authUser: "",
      model: FLASH_MODEL,
      prompt: "Hello",
      transport,
    }).catch((caught) => caught);

    expect(error).toMatchObject({ status: 502, code: "gemini_web_upstream_error" });
    expect(String(error.message)).not.toContain("evil.example");
  });

  it("rejects a model without complete routing metadata before dispatch", async () => {
    const { transport, calls } = generateTransport();
    for (const model of [
      { ...FLASH_MODEL, modelId: "" },
      { ...FLASH_MODEL, modelNumber: 0 },
      { ...FLASH_MODEL, capacity: 0 },
      { ...FLASH_MODEL, capacityField: 11 },
    ]) {
      await expect(
        generateGeminiWeb({
          session: BASE_SESSION,
          authUser: "",
          model,
          prompt: "Hello",
          transport,
        })
      ).rejects.toMatchObject({ status: 400 });
    }
    expect(calls).toHaveLength(0);
  });
});

describe("Gemini Web stream decoding", () => {
  it("handles XSSI, numeric lengths, multiline JSON and UTF-8 split at every byte", async () => {
    const modern = payloadFrame(
      [null, ["c_conversation", "r_response"], { 7: ["café ✓ 日本語 complete"] }]
    );
    const pretty = JSON.stringify(modern, null, 2);
    const classic = JSON.stringify(answerFrame("café ✓ 日本語"));
    const unrelated = JSON.stringify([["di", 0]]);
    const body =
      ")]}'\n\n" +
      `${Buffer.byteLength(unrelated)}\n${unrelated}\n` +
      `${Buffer.byteLength(classic)}\n${classic}\n` +
      `${Buffer.byteLength(pretty)}\n${pretty}\n`;

    const events = await collect(
      decodeGeminiWebStream(streamFromText(body, [1]), { knownModelIds: new Set() })
    );

    const textEvents = events.filter((event) => event.type === "text").map((event) => event.text);
    expect(textEvents).toEqual(["café ✓ 日本語", "café ✓ 日本語 complete"]);
  });

  it("emits cumulative thought summaries, collapses adjacent duplicates, and ignores empty progress frames", async () => {
    const body = lengthPrefixedBody([
      payloadFrame(labelPayload("Analyzing travel")),
      payloadFrame(labelPayload("Analyzing travel")),
      payloadFrame([null, ["c", "r"], { 7: [""] }]),
      payloadFrame(labelPayload("Analyzing travel")),
      payloadFrame(labelPayload("Comparing itineraries")),
      answerFrame("The cheaper option is the second itinerary."),
    ]);

    const events = await collect(decodeGeminiWebStream(streamFromText(body), {}));
    const reasoning = events
      .filter((event) => event.type === "reasoning")
      .map((event) => event.text);
    expect(reasoning).toEqual([
      "Analyzing travel",
      "Analyzing travel\nComparing itineraries",
    ]);
    expect(events.filter((event) => event.type === "text").map((event) => event.text)).toEqual([
      "The cheaper option is the second itinerary.",
    ]);
  });

  it("prefers thought labels over inline ctrl markers and strips citation/fence artifacts", async () => {
    const raw =
      "<ctrl94>thought\nWeighing the options\n<ctrl95>Here is the total [cite: 3, 7]:\n\n" +
      "```python?code_reference&code_event_index=1\nprint(2 + 2)\n\n```\n\n" +
      "That is all [cite_start]done.";
    const expected =
      "Here is the total:\n\n```python\nprint(2 + 2)\n\n```\n\nThat is all done.";

    const body = lengthPrefixedBody([labelFrame("Reading the question"), answerFrame(raw)]);
    const events = await collect(decodeGeminiWebStream(streamFromText(body), {}));

    expect(events.filter((event) => event.type === "reasoning").map((event) => event.text)).toEqual([
      "Reading the question",
    ]);
    expect(events.filter((event) => event.type === "text").map((event) => event.text)).toEqual([
      expected,
    ]);
  });

  it("keeps incomplete marker suffixes as ordinary text", async () => {
    for (const text of ["Partial <ctrl9", "see [cite: 12", "fence ```python?code_ref"]) {
      const body = lengthPrefixedBody([answerFrame(text)]);
      const events = await collect(decodeGeminiWebStream(streamFromText(body), {}));
      expect(events.filter((event) => event.type === "text").map((event) => event.text)).toEqual([
        text,
      ]);
    }
  });

  it("emits later usage metadata and only dedicated generated-image records", async () => {
    const imageUrl = "https://lh3.googleusercontent.com/generated-image=w1024-h1024";
    const body = lengthPrefixedBody([
      usageFrame("Here is the image", {
        promptTokenCount: 11,
        candidatesTokenCount: 7,
        totalTokenCount: 18,
      }),
      imageFrame({ url: imageUrl, text: "Here is the image" }),
      imageFrame({ url: "https://evil.example/image.png", text: "Here is the image" }),
    ]);

    const events = await collect(decodeGeminiWebStream(streamFromText(body), {}));
    const usage = events.filter((event) => event.type === "usage");
    expect(usage).toEqual([
      { type: "usage", usage: { promptTokens: 11, completionTokens: 7, totalTokens: 18 } },
    ]);
    const images = events.filter((event) => event.type === "images").flatMap((event) => event.images);
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ url: imageUrl, mime: "image/png", width: 1024, height: 768 });
  });

  it("accepts an image-only result and rejects a thought-only completion", async () => {
    const imageUrl = "https://lh3.googleusercontent.com/generated-image";
    const imageOnly = await collect(
      decodeGeminiWebStream(
        streamFromText(lengthPrefixedBody([imageFrame({ url: imageUrl })])),
        {}
      )
    );
    expect(imageOnly.filter((event) => event.type === "images")).toHaveLength(1);

    const thoughtOnly = decodeGeminiWebStream(
      streamFromText(lengthPrefixedBody([labelFrame("Still thinking")])),
      {}
    );
    await expect(collect(thoughtOnly)).rejects.toMatchObject({
      status: 502,
      code: "gemini_web_upstream_error",
    });
  });

  it("surfaces BardErrorInfo numeric codes as a 502 without speculative classifications", async () => {
    const error = await collect(
      decodeGeminiWebStream(streamFromText(BARD_ERROR_FIXTURE), {})
    ).catch((caught) => caught);

    expect(error).toMatchObject({ status: 502, code: "gemini_web_upstream_error" });
    expect(String(error.message)).toContain("13");
    expect(String(error.message)).toContain("1152");
    expect(String(error.message)).not.toMatch(/quota|context window|rate limit/i);
  });

  it("fails a truncated frame and a frame larger than eight MiB", async () => {
    const truncated = ")]}'\n\n42\n[[\"wrb.fr\",\"rpc\",\"[null,";
    await expect(
      collect(decodeGeminiWebStream(streamFromText(truncated), {}))
    ).rejects.toMatchObject({ status: 502 });

    const huge = lengthPrefixedBody([answerFrame("a".repeat(8 * 1024 * 1024 + 1))]);
    await expect(
      collect(decodeGeminiWebStream(streamFromText(huge, [64 * 1024]), {}))
    ).rejects.toMatchObject({ status: 502 });
  });

  it("keeps a shorter prefix frame silent but rejects a divergent revision", async () => {
    const prefixBody = lengthPrefixedBody([
      answerFrame("Hello world"),
      answerFrame("Hello"),
      answerFrame("Hello world!"),
    ]);
    const prefixEvents = await collect(decodeGeminiWebStream(streamFromText(prefixBody), {}));
    expect(prefixEvents.filter((event) => event.type === "text").map((event) => event.text)).toEqual([
      "Hello world",
      "Hello world!",
    ]);

    const divergentBody = lengthPrefixedBody([
      answerFrame("Hello world"),
      answerFrame("Goodbye"),
    ]);
    const { events, error } = await collectUntilError(
      decodeGeminiWebStream(streamFromText(divergentBody), {})
    );
    expect(events.filter((event) => event.type === "text").map((event) => event.text)).toEqual([
      "Hello world",
    ]);
    expect(error).toMatchObject({ status: 502, code: "gemini_web_upstream_error" });
  });

  it("emits model identity only from protocol records and only while unique", async () => {
    const first = "1111111111111111";
    const second = "2222222222222222";
    const body = lengthPrefixedBody([
      payloadFrame(answerPayloadWithMetadata("hello", first), { metadata: first }),
      payloadFrame(answerPayloadWithMetadata(`hello ${second}`, first), { metadata: first }),
      payloadFrame(answerPayloadWithMetadata("hello", first), { metadata: second }),
    ]);

    const events = await collect(
      decodeGeminiWebStream(streamFromText(body), {
        knownModelIds: new Set([first, second]),
      })
    );
    const modelEvents = events.filter((event) => event.type === "model").map((event) => event.modelId);
    expect(modelEvents).toEqual([first, null]);
  });

  it("cancels the upstream reader when the caller aborts", async () => {
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(")]}'\n\n"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const controller = new AbortController();
    const iterator = decodeGeminiWebStream(body, { signal: controller.signal });
    const consuming = collect(iterator);
    setTimeout(() => controller.abort(), 10);

    await expect(consuming).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled).toBe(true);
  });
});

function answerPayloadWithMetadata(text, modelId) {
  const payload = [null, "c_conversation", null, null, [["c_choice", [text]]]];
  payload[3] = { model: modelId };
  return payload;
}
