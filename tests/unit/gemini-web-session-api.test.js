import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupGeminiWebDb } from "../helpers/geminiWebDb.js";

// Only the outbound Google probe is simulated. Everything else below runs the
// real service and the disposable SQLite fixture.
const executor = vi.hoisted(() => ({
  probeGeminiWebConnection: vi.fn(),
  resolveGeminiWebModels: vi.fn(),
}));

vi.mock("../../open-sse/executors/gemini-web.js", () => executor);

vi.mock("next/server", () => ({
  NextResponse: class NextResponse extends Response {
    static json(body, init = {}) {
      return new Response(JSON.stringify(body), {
        status: init.status || 200,
        headers: { "Content-Type": "application/json" },
      });
    }
  },
}));

const fixture = await setupGeminiWebDb();
const service = await import("../../src/lib/geminiWebAccounts.js");
const sessionsRoute = await import("../../src/app/api/providers/gemini-web/sessions/route.js");
const sessionRoute = await import("../../src/app/api/providers/gemini-web/sessions/[sessionId]/route.js");
const providersRoute = await import("../../src/app/api/providers/route.js");
const connections = await import("../../src/lib/db/repos/connectionsRepo.js");
const sessionsRepo = await import("../../src/lib/db/repos/geminiWebSessionsRepo.js");
const proxyPools = await import("../../src/lib/db/repos/proxyPoolsRepo.js");

const BASE = "http://127.0.0.1:20129";
const COOKIE = "__Secure-1PSID=synthetic-api-psid; __Secure-1PSIDTS=synthetic-api-psidts";
const SESSIONS_PATH = "/api/providers/gemini-web/sessions";

function jsonRequest(path, { method = "POST", body, headers = {}, signal } = {}) {
  return new Request(`${BASE}${path}`, {
    method,
    headers: { origin: BASE, "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}

function sessionParams(sessionId) {
  return { params: Promise.resolve({ sessionId }) };
}

function updateSession(sessionId, body, headers) {
  return jsonRequest(`${SESSIONS_PATH}/${sessionId}`, { method: "PUT", body, headers });
}

async function bodyOf(response) {
  return response.status === 204 ? null : response.json();
}

function createSession(overrides = {}) {
  return service.createGeminiWebSession({
    name: "Jar",
    cookieHeader: COOKIE,
    authUsers: ["0"],
    proxyPoolId: null,
    ...overrides,
  });
}

async function seedPool(id, overrides = {}) {
  return proxyPools.createProxyPool({
    id,
    name: id,
    proxyUrl: "http://127.0.0.1:9",
    isActive: true,
    ...overrides,
  });
}

// Deletes the pool row at the second read: the service validates it, then the
// proxy resolver reads it again. This is the real deletion window, executed by
// the real repository and resolver rather than a stubbed service result.
function dropPoolOnSecondRead(poolId) {
  const adapter = fixture.adapter;
  const original = adapter.get;
  let reads = 0;
  adapter.get = (sql, params) => {
    const isPoolRead = /FROM proxyPools WHERE id = \?/.test(sql) && params?.[0] === poolId;
    if (isPoolRead && reads++ > 0) return null;
    return original.call(adapter, sql, params);
  };
  return () => {
    adapter.get = original;
  };
}

beforeEach(() => {
  fixture.clear();
  fixture.adapter.run("DELETE FROM proxyPools");
  executor.probeGeminiWebConnection.mockReset();
  executor.resolveGeminiWebModels.mockReset();
  executor.probeGeminiWebConnection.mockImplementation(async (credentials) => ({
    status: "valid",
    account: { name: `Google ${credentials.providerSpecificData.authUser || "default"}` },
  }));
  executor.resolveGeminiWebModels.mockResolvedValue([{ id: "gemini-everyday-help", name: "Everyday help" }]);
});

afterAll(() => fixture.teardown());

describe("Gemini Web session update revision contract", () => {
  it.each([
    ["omitted", {}],
    ["null", { expectedRevision: null }],
    ["zero", { expectedRevision: 0 }],
    ["negative", { expectedRevision: -2 }],
    ["fractional", { expectedRevision: 1.5 }],
    ["numeric string", { expectedRevision: "1" }],
    ["boolean", { expectedRevision: true }],
  ])("rejects a %s expectedRevision with 400 before probing", async (_label, revision) => {
    const created = await createSession();
    executor.probeGeminiWebConnection.mockClear();

    const response = await sessionRoute.PUT(
      updateSession(created.session.id, { name: "Should not save", ...revision }),
      sessionParams(created.session.id)
    );

    expect(response.status).toBe(400);
    expect(executor.probeGeminiWebConnection).not.toHaveBeenCalled();
    const persisted = await service.getGeminiWebSessionView(created.session.id);
    expect(persisted).toMatchObject({ name: "Jar", revision: created.session.revision });
  });

  it("rejects a stale revision with 409 and leaves the newer name in place", async () => {
    const created = await createSession();
    const bumped = await sessionsRepo.saveGeminiWebSession(
      { id: created.session.id, name: "Newer name" },
      { expectedRevision: created.session.revision }
    );
    executor.probeGeminiWebConnection.mockClear();

    const response = await sessionRoute.PUT(
      updateSession(created.session.id, {
        name: "Stale writer",
        expectedRevision: created.session.revision,
      }),
      sessionParams(created.session.id)
    );

    expect(response.status).toBe(409);
    expect((await bodyOf(response)).code).toBe("GEMINI_WEB_SESSION_CONFLICT");
    expect(executor.probeGeminiWebConnection).not.toHaveBeenCalled();
    const persisted = await service.getGeminiWebSessionView(created.session.id);
    expect(persisted).toMatchObject({ name: "Newer name", revision: bumped.revision });
  });

  it("returns 404 for an unknown session without probing", async () => {
    const response = await sessionRoute.PUT(
      updateSession("missing-session", { expectedRevision: 1, name: "Nowhere" }),
      sessionParams("missing-session")
    );

    expect(response.status).toBe(404);
    expect(executor.probeGeminiWebConnection).not.toHaveBeenCalled();
  });
});

describe("Gemini Web session input validation", () => {
  it.each([
    ["an empty slot list", []],
    ["a non-array slot list", "0"],
    ["a negative slot", ["-1"]],
    ["a fractional slot", ["1.5"]],
    ["an object slot", [{ slot: 0 }]],
  ])("rejects %s with 400 before probing", async (_label, authUsers) => {
    const created = await createSession();
    executor.probeGeminiWebConnection.mockClear();

    const response = await sessionRoute.PUT(
      updateSession(created.session.id, {
        expectedRevision: created.session.revision,
        authUsers,
        proxyPoolId: null,
      }),
      sessionParams(created.session.id)
    );

    expect(response.status).toBe(400);
    expect(executor.probeGeminiWebConnection).not.toHaveBeenCalled();
    const view = await service.getGeminiWebSessionView(created.session.id);
    expect(view.connections).toMatchObject([{ authUser: "0" }]);
    expect(view.connections).toHaveLength(1);
  });

  it("rejects an invalid slot when creating a session", async () => {
    const response = await sessionsRoute.POST(jsonRequest(SESSIONS_PATH, {
      body: { name: "Bad slot", cookieHeader: COOKIE, authUsers: ["-1"], proxyPoolId: null },
    }));

    expect(response.status).toBe(400);
    expect(executor.probeGeminiWebConnection).not.toHaveBeenCalled();
    expect(await connections.getProviderConnections({ provider: "gemini-web" })).toEqual([]);
    expect(await service.listGeminiWebSessionViews()).toEqual([]);
  });

  it("rejects a cookie without __Secure-1PSID before probing and persists nothing", async () => {
    const response = await sessionsRoute.POST(jsonRequest(SESSIONS_PATH, {
      body: { name: "Bad cookie", cookieHeader: "NID=only-a-nid", authUsers: ["0"], proxyPoolId: null },
    }));

    expect(response.status).toBe(400);
    expect(executor.probeGeminiWebConnection).not.toHaveBeenCalled();
    expect(await connections.getProviderConnections({ provider: "gemini-web" })).toEqual([]);
    expect(await service.listGeminiWebSessionViews()).toEqual([]);
  });

  it("rejects an invalid replacement cookie before probing and keeps the stored jar", async () => {
    const created = await createSession();
    executor.probeGeminiWebConnection.mockClear();

    const response = await sessionRoute.PUT(
      updateSession(created.session.id, {
        expectedRevision: created.session.revision,
        cookieHeader: "NID=only-a-nid",
      }),
      sessionParams(created.session.id)
    );

    expect(response.status).toBe(400);
    expect(executor.probeGeminiWebConnection).not.toHaveBeenCalled();
    const stored = await sessionsRepo.getGeminiWebSession(created.session.id);
    expect(stored.cookieHeader).toBe(COOKIE);
    expect(stored.revision).toBe(created.session.revision);
  });

  it("answers 400 instead of 500 for a malformed JSON body", async () => {
    const created = await createSession();
    executor.probeGeminiWebConnection.mockClear();

    const response = await sessionRoute.PUT(
      new Request(`${BASE}${SESSIONS_PATH}/${created.session.id}`, {
        method: "PUT",
        headers: { origin: BASE, "content-type": "application/json" },
        body: "{not-json",
      }),
      sessionParams(created.session.id)
    );

    expect(response.status).toBe(400);
    expect(executor.probeGeminiWebConnection).not.toHaveBeenCalled();
    const persisted = await service.getGeminiWebSessionView(created.session.id);
    expect(persisted).toMatchObject({ name: "Jar", revision: created.session.revision });
  });
});

describe("Gemini Web new-account proxy pools", () => {
  it.each([
    ["an unknown pool", "missing-pool", null],
    ["an inactive pool", "pool-inactive", { isActive: false }],
    ["a pool without a proxy URL", "pool-empty-url", { proxyUrl: "   " }],
  ])("rejects %s with 400 before any Google probe", async (_label, poolId, overrides) => {
    if (overrides) await seedPool(poolId, overrides);

    const response = await sessionsRoute.POST(jsonRequest(SESSIONS_PATH, {
      body: { name: "Bad proxy", cookieHeader: COOKIE, authUsers: ["0"], proxyPoolId: poolId },
    }));

    expect(response.status).toBe(400);
    expect(executor.probeGeminiWebConnection).not.toHaveBeenCalled();
    expect(await connections.getProviderConnections({ provider: "gemini-web" })).toEqual([]);
    expect(await service.listGeminiWebSessionViews()).toEqual([]);
  });

  it("persists and probes through an explicitly requested usable pool", async () => {
    await seedPool("pool-valid");

    const response = await sessionsRoute.POST(jsonRequest(SESSIONS_PATH, {
      body: { name: "Proxied", cookieHeader: COOKIE, authUsers: ["0"], proxyPoolId: "pool-valid" },
    }));
    const body = await bodyOf(response);

    expect(response.status).toBe(201);
    expect(body.connections).toMatchObject([{ authUser: "0", name: "Google 0" }]);
    const rows = await connections.getProviderConnections({ provider: "gemini-web" });
    expect(rows).toHaveLength(1);
    expect(rows[0].providerSpecificData.proxyPoolId).toBe("pool-valid");
    expect(executor.probeGeminiWebConnection).toHaveBeenCalledTimes(1);
    expect(executor.probeGeminiWebConnection.mock.calls[0][1].proxyOptions).toMatchObject({
      source: "pool",
      proxyPoolId: "pool-valid",
      connectionProxyUrl: "http://127.0.0.1:9",
    });
  });

  it("rejects an unknown pool for a newly added slot before probing and keeps membership", async () => {
    const created = await createSession();
    executor.probeGeminiWebConnection.mockClear();

    const response = await sessionRoute.PUT(
      updateSession(created.session.id, {
        expectedRevision: created.session.revision,
        authUsers: ["0", "2"],
        proxyPoolId: "missing-pool",
      }),
      sessionParams(created.session.id)
    );

    expect(response.status).toBe(400);
    expect(executor.probeGeminiWebConnection).not.toHaveBeenCalled();
    const view = await service.getGeminiWebSessionView(created.session.id);
    expect(view.connections).toMatchObject([{ authUser: "0" }]);
    expect(view.connections).toHaveLength(1);
  });

  it("adds a slot through its explicit pool without relabeling the existing account", async () => {
    const created = await createSession();
    await connections.updateProviderConnection(created.connections[0].id, { name: "Custom zero" });
    await seedPool("pool-new-slot");
    executor.probeGeminiWebConnection.mockClear();

    const response = await sessionRoute.PUT(
      updateSession(created.session.id, {
        expectedRevision: created.session.revision,
        authUsers: ["0", "2"],
        proxyPoolId: "pool-new-slot",
      }),
      sessionParams(created.session.id)
    );
    const body = await bodyOf(response);

    expect(response.status).toBe(200);
    expect(body.connections).toMatchObject([
      { authUser: "0", name: "Custom zero" },
      { authUser: "2", name: "Google 2" },
    ]);
    const rows = await connections.getProviderConnections({ provider: "gemini-web" });
    const added = rows.find((row) => row.providerSpecificData.authUser === "2");
    expect(added.providerSpecificData.proxyPoolId).toBe("pool-new-slot");
    expect(rows.find((row) => row.providerSpecificData.authUser === "0").name).toBe("Custom zero");
    const addedProbe = executor.probeGeminiWebConnection.mock.calls.find(
      ([credentials]) => credentials.providerSpecificData.authUser === "2"
    );
    expect(addedProbe[1].proxyOptions).toMatchObject({ source: "pool", proxyPoolId: "pool-new-slot" });
  });

  it("rejects a pool deleted between validation and resolution instead of probing direct", async () => {
    await seedPool("pool-race-create");
    const restore = dropPoolOnSecondRead("pool-race-create");

    try {
      const response = await sessionsRoute.POST(jsonRequest(SESSIONS_PATH, {
        body: { name: "Race", cookieHeader: COOKIE, authUsers: ["0"], proxyPoolId: "pool-race-create" },
      }));

      expect(response.status).toBe(400);
      expect(executor.probeGeminiWebConnection).not.toHaveBeenCalled();
      expect(await connections.getProviderConnections({ provider: "gemini-web" })).toEqual([]);
      expect(await service.listGeminiWebSessionViews()).toEqual([]);
    } finally {
      restore();
    }
  });

  it("rejects a new slot whose pool disappears before resolution without touching accounts", async () => {
    const created = await createSession();
    await seedPool("pool-race-update");
    executor.probeGeminiWebConnection.mockClear();
    const restore = dropPoolOnSecondRead("pool-race-update");

    try {
      const response = await sessionRoute.PUT(
        updateSession(created.session.id, {
          expectedRevision: created.session.revision,
          authUsers: ["2"],
          proxyPoolId: "pool-race-update",
        }),
        sessionParams(created.session.id)
      );

      expect(response.status).toBe(400);
      expect(executor.probeGeminiWebConnection).not.toHaveBeenCalled();
      const view = await service.getGeminiWebSessionView(created.session.id);
      expect(view).toMatchObject({ name: "Jar", revision: created.session.revision });
      expect(view.connections).toMatchObject([{ authUser: "0" }]);
      expect(view.connections).toHaveLength(1);
    } finally {
      restore();
    }
  });
});

describe("Gemini Web session cookie replacement", () => {
  it("revalidates every linked slot and keeps their custom labels", async () => {
    const created = await createSession({ authUsers: ["0", "2"] });
    await connections.updateProviderConnection(created.connections[0].id, { name: "Custom zero" });
    const nextCookie = "__Secure-1PSID=synthetic-api-psid; __Secure-1PSIDTS=rotated-psidts";
    executor.probeGeminiWebConnection.mockClear();

    const response = await sessionRoute.PUT(
      updateSession(created.session.id, {
        expectedRevision: created.session.revision,
        cookieHeader: nextCookie,
      }),
      sessionParams(created.session.id)
    );
    const body = await bodyOf(response);

    expect(response.status).toBe(200);
    expect(body.connections).toMatchObject([
      { authUser: "0", name: "Custom zero" },
      { authUser: "2", name: "Google 2" },
    ]);
    const probedSlots = executor.probeGeminiWebConnection.mock.calls
      .map(([credentials]) => credentials.providerSpecificData.authUser)
      .sort();
    expect(probedSlots).toEqual(["0", "2"]);
    const stored = await sessionsRepo.getGeminiWebSession(created.session.id);
    expect(stored.cookieHeader).toContain("__Secure-1PSIDTS=rotated-psidts");
  });
});

describe("Gemini Web session terminal statuses", () => {
  it("keeps 409 for deleting a session that still has accounts", async () => {
    const created = await createSession();

    const response = await sessionRoute.DELETE(
      jsonRequest(`${SESSIONS_PATH}/${created.session.id}`, { method: "DELETE" }),
      sessionParams(created.session.id)
    );

    expect(response.status).toBe(409);
    expect((await bodyOf(response)).code).toBe("cookie_session_in_use");
    expect(await service.getGeminiWebSessionView(created.session.id)).toBeTruthy();
  });

  it("returns 503 when the Google probe result is unknown", async () => {
    executor.probeGeminiWebConnection.mockResolvedValue({ status: "unknown", error: "rate limited" });

    const response = await sessionsRoute.POST(jsonRequest(SESSIONS_PATH, {
      body: { name: "Unknown", cookieHeader: COOKIE, authUsers: ["0"], proxyPoolId: null },
    }));

    expect(response.status).toBe(503);
    expect(await service.listGeminiWebSessionViews()).toEqual([]);
  });

  it("returns 499 when the caller aborts during verification and saves nothing", async () => {
    const created = await createSession();
    const controller = new AbortController();
    let release;
    let entered;
    const gate = new Promise((resolve) => { release = resolve; });
    const started = new Promise((resolve) => { entered = resolve; });
    executor.probeGeminiWebConnection.mockImplementationOnce(async () => {
      entered();
      await gate;
      return { status: "valid", account: { name: "Late identity" } };
    });

    const saving = sessionRoute.PUT(
      jsonRequest(`${SESSIONS_PATH}/${created.session.id}`, {
        method: "PUT",
        body: { expectedRevision: created.session.revision, authUsers: ["0", "2"], proxyPoolId: null },
        signal: controller.signal,
      }),
      sessionParams(created.session.id)
    );
    await started;
    controller.abort();
    release();
    const response = await saving;

    expect(response.status).toBe(499);
    const persisted = await service.getGeminiWebSessionView(created.session.id);
    expect(persisted).toMatchObject({ name: "Jar", revision: created.session.revision });
    expect(persisted.connections).toMatchObject([{ authUser: "0" }]);
    expect(persisted.connections).toHaveLength(1);
  });
});

describe("POST /api/providers Gemini Web origin guard", () => {
  it("answers 403 instead of 500 for a cross-site request", async () => {
    const response = await providersRoute.POST(jsonRequest("/api/providers", {
      body: { provider: "gemini-web", apiKey: COOKIE, name: "Cross site" },
      headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
    }));

    expect(response.status).toBe(403);
    expect((await bodyOf(response)).code).toBe("mutation_origin_denied");
    expect(await connections.getProviderConnections()).toEqual([]);
  });
});
