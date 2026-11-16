import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupGeminiWebDb } from "../helpers/geminiWebDb.js";

const accounts = vi.hoisted(() => new Map());
vi.mock("../../open-sse/executors/gemini-web.js", () => ({
  probeGeminiWebConnection: vi.fn(async (credentials) => ({
    status: "valid",
    account: accounts.get(credentials.providerSpecificData.authUser) || null,
  })),
  resolveGeminiWebModels: vi.fn(async () => [{ id: "gemini-everyday-help", name: "Everyday help" }]),
}));

const fixture = await setupGeminiWebDb();
const service = await import("../../src/lib/geminiWebAccounts.js");
const connections = await import("../../src/lib/db/repos/connectionsRepo.js");
const COOKIE = "__Secure-1PSID=synthetic-names-session; __Secure-1PSIDTS=synthetic-names-timestamp";

beforeEach(() => {
  fixture.clear();
  accounts.clear();
  vi.clearAllMocks();
  accounts.set("0", { name: "Alice Example", email: "alice@example.test" });
  accounts.set("2", { name: "bob@example.test", email: "bob@example.test" });
});
afterAll(() => fixture.teardown());

describe("Gemini Web automatic account labels", () => {
  it("persists a separate verified identity for each slot and keeps the session label separate", async () => {
    const saved = await service.createGeminiWebSession({ name: "Browser jar", cookieHeader: COOKIE, authUsers: ["0", "2"], proxyPoolId: null });
    expect(saved.session.name).toBe("Browser jar");
    expect(saved.connections.map(({ authUser, name }) => ({ authUser, name }))).toEqual([
      { authUser: "0", name: "Alice Example" },
      { authUser: "2", name: "bob@example.test" },
    ]);
    const persisted = await connections.getProviderConnections({ provider: "gemini-web" });
    expect(persisted.map((row) => row.name)).toEqual(["Alice Example", "bob@example.test"]);
    expect(JSON.stringify(saved)).not.toContain(COOKIE);
  });

  it("names newly added slots without overwriting a customized existing name", async () => {
    const initial = await service.createGeminiWebSession({ cookieHeader: COOKIE, authUsers: ["0"], proxyPoolId: null });
    await connections.updateProviderConnection(initial.connections[0].id, { name: "My coding account" });
    const saved = await service.updateGeminiWebSession(initial.session.id, {
      expectedRevision: initial.session.revision,
      authUsers: ["0", "2"],
      proxyPoolId: null,
    });
    expect(saved.connections.map((row) => row.name)).toEqual(["My coding account", "bob@example.test"]);
    const retried = await service.createGeminiWebSession({ cookieHeader: COOKIE, authUsers: ["0", "2"], proxyPoolId: null });
    expect(retried.session.id).toBe(initial.session.id);
    expect(retried.connections.map((row) => row.name)).toEqual(["My coding account", "bob@example.test"]);
  });

  it("reconnects a deleted account from its retained cookie session without another cookie header", async () => {
    const initial = await service.createGeminiWebSession({ cookieHeader: COOKIE, authUsers: ["0"], proxyPoolId: null });
    await service.detachGeminiWebConnection(initial.connections[0].id);
    const retained = await service.getGeminiWebSessionView(initial.session.id);
    expect(retained.connections).toEqual([]);
    const reconnected = await service.updateGeminiWebSession(retained.id, {
      expectedRevision: retained.revision,
      authUsers: ["0"],
      proxyPoolId: null,
    });
    expect(reconnected.session.id).toBe(retained.id);
    expect(reconnected.connections).toMatchObject([{ authUser: "0", name: "Alice Example" }]);
    expect(reconnected.connections[0].id).not.toBe(initial.connections[0].id);
    expect(JSON.stringify(reconnected)).not.toContain(COOKIE);
  });
  it.each(["create", "update"])("does not persist a late %s verification after cancellation", async (operation) => {
    const initial = operation === "update"
      ? await service.createGeminiWebSession({ cookieHeader: COOKIE, authUsers: ["0"], proxyPoolId: null })
      : null;
    let release;
    let entered;
    const gate = new Promise((resolve) => { release = resolve; });
    const started = new Promise((resolve) => { entered = resolve; });
    const executor = await import("../../open-sse/executors/gemini-web.js");
    executor.probeGeminiWebConnection.mockImplementationOnce(async () => {
      entered();
      await gate;
      return { status: "valid", account: accounts.get("2") };
    });
    const controller = new AbortController();
    const saving = operation === "update"
      ? service.updateGeminiWebSession(initial.session.id, {
          expectedRevision: initial.session.revision, authUsers: ["2"], proxyPoolId: null,
        }, { signal: controller.signal })
      : service.createGeminiWebSession({ cookieHeader: COOKIE, authUsers: ["2"], proxyPoolId: null, signal: controller.signal });
    await started;
    controller.abort();
    release();
    await expect(saving).rejects.toMatchObject({ name: "AbortError" });
    const views = await service.listGeminiWebSessionViews();
    if (initial) {
      expect(views).toMatchObject([{ id: initial.session.id, revision: initial.session.revision, connections: [{ authUser: "0" }] }]);
      expect(views[0].connections).toHaveLength(1);
    } else {
      expect(views).toEqual([]);
    }
  });

  it("restores legacy Gemini cookies after promotion was already cached without changing another provider", async () => {
    await service.ensureLegacyGeminiWebPromotion();
    const database = await import("../../src/lib/db/index.js");
    await database.importDb({
      providerConnections: [
        { id: "restored-gemini", provider: "gemini-web", authType: "cookie", name: "Restored account", apiKey: COOKIE, isActive: true, priority: 1 },
        { id: "restored-openai", provider: "openai", authType: "apikey", apiKey: "synthetic-unrelated-key", isActive: true, priority: 1 },
      ],
    });
    await service.ensureLegacyGeminiWebPromotion();
    const restored = await connections.getProviderConnectionById("restored-gemini");
    expect(service.geminiWebAccountIsUsable(restored)).toBe(true);
    expect(JSON.stringify(restored)).not.toContain(COOKIE);
    const credentials = await service.hydrateGeminiWebCredentials(restored);
    expect(credentials.apiKey).toBe(COOKIE);
    expect(credentials.providerSpecificData.authUser).toBe("");
    expect((await connections.getProviderConnectionById("restored-openai")).apiKey).toBe("synthetic-unrelated-key");
  });

  it("keeps the existing slot label fallback when Google omits identity metadata", async () => {
    accounts.clear();

    const saved = await service.createGeminiWebSession({ name: "Work", cookieHeader: COOKIE, authUsers: ["2"], proxyPoolId: null });
    expect(saved.connections[0].name).toBe("Work / 2");
  });

  it("renames a session locally without probing Google or relabeling its accounts", async () => {
    const initial = await service.createGeminiWebSession({ name: "Old label", cookieHeader: COOKIE, authUsers: ["0"], proxyPoolId: null });
    await connections.updateProviderConnection(initial.connections[0].id, { name: "My coding account" });
    const executor = await import("../../open-sse/executors/gemini-web.js");
    executor.probeGeminiWebConnection.mockClear();
    executor.resolveGeminiWebModels.mockClear();

    const renamed = await service.updateGeminiWebSession(initial.session.id, {
      expectedRevision: initial.session.revision,
      name: "Renamed jar",
    });

    expect(renamed.session).toMatchObject({
      id: initial.session.id,
      name: "Renamed jar",
      revision: initial.session.revision + 1,
    });
    expect(renamed.connections).toMatchObject([{ authUser: "0", name: "My coding account" }]);
    expect(executor.probeGeminiWebConnection).not.toHaveBeenCalled();
    expect(executor.resolveGeminiWebModels).not.toHaveBeenCalled();

    const persistedSession = await service.getGeminiWebSessionView(initial.session.id);
    expect(persistedSession).toMatchObject({ name: "Renamed jar", revision: initial.session.revision + 1 });
    expect(persistedSession.connections).toMatchObject([{ authUser: "0", name: "My coding account" }]);
  });
});
