import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("open-sse/index.js", () => ({}), { virtual: true });

vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(),
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(),
}));

vi.mock("@/app/api/usage/[connectionId]/route.js", () => ({
  refreshAndUpdateCredentials: vi.fn(),
}));

vi.mock("@/shared/constants/config", () => ({
  QUOTA_AUTOPING_CONFIG: {
    tickIntervalMs: 60000,
    pingLeadMs: 5000,
    refreshAheadMs: 300000,
    failureCooldownMs: 900000,
    scanTimeoutMs: 10000,
    attemptTimeoutMs: 60000,
    providers: {
      claude: {
        settingsKey: "claudeAutoPing",
        quotaKey: "session (5h)",
        pingModel: "claude-haiku-4-5-20251001",
        pingText: "hi",
        pingMaxTokens: 1,
      },
      codex: {
        settingsKey: "codexAutoPing",
        quotaKey: "session",
        blockingQuotaKeys: ["weekly", "monthly"],
        pingWhenResetAtSlides: true,
        resetAtDriftMs: 30000,
        minPingIntervalMs: 600000,
        skipWhenBlockingQuotaExhausted: true,
        pingModel: "gpt-5.6-terra",
        pingText: "hi",
        pingInstructions: "Reply with OK.",
        pingReasoningEffort: "none",
      },
      factory: {
        settingsKey: "factoryAutoPing",
        quotaKey: "standard_5h",
        blockingQuotaKeys: ["standard_weekly", "standard_monthly"],
        pingWhenWindowInactive: true,
        skipWhenBlockingQuotaExhausted: true,
        minPingIntervalMs: 600000,
        pingModel: "glm-5.3-flash",
        pingText: "hi",
        pingMaxTokens: 1,
      },
    },
  },
}));

vi.mock("open-sse/providers/shared.js", () => ({
  CLAUDE_CLI_SPOOF_HEADERS: { "anthropic-version": "2023-06-01" },
}));

vi.mock("open-sse/services/usage/shared.js", () => ({
  U: () => ({ baseUrl: "https://chatgpt.com/backend-api/codex/responses" }),
}));

vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

vi.mock("open-sse/services/usage/claude.js", () => ({
  getClaudeUsage: vi.fn(),
}));

vi.mock("open-sse/services/usage/factory.js", () => ({
  getFactoryUsage: vi.fn(),
}));

vi.mock("open-sse/services/usage/codex.js", () => ({
  getCodexUsage: vi.fn(),
}));

vi.mock("open-sse/executors/index.js", () => ({
  getExecutor: vi.fn(),
}));

describe("quota auto-ping", () => {
  let runQuotaAutoPingTick;
  let configureQuotaAutoPing;
  let deps;
  let state;
  let getCodexUsage;
  let getClaudeUsage;
  let getFactoryUsage;
  let getExecutor;
  let codexResponseText;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useRealTimers();
    delete global.__quotaAutoPing;

    ({ getCodexUsage } = await import("open-sse/services/usage/codex.js"));
    ({ getClaudeUsage } = await import("open-sse/services/usage/claude.js"));
    ({ getFactoryUsage } = await import("open-sse/services/usage/factory.js"));
    ({ getExecutor } = await import("open-sse/executors/index.js"));
    ({ runQuotaAutoPingTick, configureQuotaAutoPing } = await import("../../src/shared/services/quotaAutoPing.js"));
    deps = {
      getSettings: vi.fn(),
      getProviderConnections: vi.fn(),
      updateProviderConnection: vi.fn(),
      resolveConnectionProxyConfig: vi.fn().mockResolvedValue({}),
      refreshAndUpdateCredentials: vi.fn(async (connection) => ({ connection, refreshed: false })),
      proxyAwareFetch: vi.fn().mockResolvedValue({ ok: true }),
      getExecutor: vi.fn(() => ({
        execute: vi.fn().mockResolvedValue({ response: { ok: true, text: codexResponseText } }),
      })),
    };
    codexResponseText = vi.fn().mockResolvedValue("");
    getExecutor.mockReturnValue({
      execute: vi.fn().mockResolvedValue({ response: { ok: true, text: codexResponseText } }),
    });
    state = { running: false, resetCache: {}, failureCache: {} };
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not ping Codex when setting is absent", async () => {
    deps.getSettings.mockResolvedValue({});

    await runQuotaAutoPingTick(deps, state);

    expect(deps.getProviderConnections).not.toHaveBeenCalled();
    expect(deps.proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("keeps opted-in Factory accounts running when Codex is disabled and stops after the last opt-out", async () => {
    vi.useFakeTimers();
    const localDb = await import("@/lib/localDb");
    const network = await import("@/lib/network/connectionProxy");
    const credentials = await import("@/app/api/usage/[connectionId]/route.js");
    const connection = { id: "factory-1", provider: "factory", authType: "oauth", accessToken: "test-token" };
    let settings = {};
    localDb.getSettings.mockImplementation(async () => settings);
    localDb.getProviderConnections.mockImplementation(async ({ provider }) => provider === "factory" ? [connection] : []);
    localDb.updateProviderConnection.mockImplementation(async (id, patch) => Object.assign(connection, patch));
    network.resolveConnectionProxyConfig.mockResolvedValue({});
    credentials.refreshAndUpdateCredentials.mockImplementation(async (conn) => ({ connection: conn }));
    getFactoryUsage.mockResolvedValue({
      quotas: { standard_5h: { used: 0, total: 100, remaining: 100, resetAt: null } },
    });
    const execute = vi.fn().mockResolvedValue({ response: { ok: true, text: async () => "OK" } });
    getExecutor.mockReturnValue({ execute });

    try {
      configureQuotaAutoPing(settings);
      await vi.advanceTimersByTimeAsync(600000);
      expect(execute).not.toHaveBeenCalled();

      settings = { factoryAutoPing: { connections: { "factory-1": true } } };
      configureQuotaAutoPing(settings);
      await vi.advanceTimersByTimeAsync(0);
      expect(execute).toHaveBeenCalledTimes(1);

      settings = { ...settings, codexAutoPing: { connections: { "codex-1": false } } };
      configureQuotaAutoPing(settings);
      await vi.advanceTimersByTimeAsync(600001);
      expect(execute).toHaveBeenCalledTimes(2);

      settings = { factoryAutoPing: { connections: { "factory-1": false } } };
      configureQuotaAutoPing(settings);
      await vi.advanceTimersByTimeAsync(1200000);
      expect(execute).toHaveBeenCalledTimes(2);
    } finally {
      configureQuotaAutoPing({});
      await vi.advanceTimersByTimeAsync(0);
    }
  });

  it("does not ping Codex on the first resetAt observation", async () => {
    deps.getSettings.mockResolvedValue({ codexAutoPing: { connections: { "codex-1": true } } });
    deps.getProviderConnections.mockImplementation(async ({ provider }) => (
      provider === "codex" ? [{ id: "codex-1", provider: "codex", authType: "oauth", accessToken: "token" }] : []
    ));
    getCodexUsage.mockResolvedValue({
      quotas: { session: { used: 1, resetAt: "2026-01-01T13:00:00.000Z" } },
    });

    await runQuotaAutoPingTick(deps, state);

    expect(deps.getExecutor).not.toHaveBeenCalled();
    expect(deps.updateProviderConnection).not.toHaveBeenCalled();
    expect(state.resetCache["codex:codex-1"]).toBe("2026-01-01T13:00:00.000Z");
  });

  it("sends Codex ping when session resetAt slides", async () => {
    deps.getSettings.mockResolvedValue({ codexAutoPing: { connections: { "codex-1": true } } });
    deps.getProviderConnections.mockImplementation(async ({ provider }) => (
      provider === "codex" ? [{ id: "codex-1", provider: "codex", authType: "oauth", accessToken: "token" }] : []
    ));
    state.resetCache["codex:codex-1"] = "2026-01-01T17:00:00.000Z";
    getCodexUsage.mockResolvedValue({
      quotas: { session: { used: 1, total: 100, remaining: 99, resetAt: "2026-01-01T17:01:00.000Z" } },
    });

    await runQuotaAutoPingTick(deps, state);

    const executor = deps.getExecutor.mock.results[0].value;
    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(deps.updateProviderConnection).toHaveBeenCalledWith("codex-1", expect.objectContaining({
      lastPingedResetAt: "2026-01-01T17:01:00.000Z",
      lastPingedResetKey: "2026-01-01T17:01:00.000Z",
    }));
  });

  it("does not ping Codex when resetAt is stable", async () => {
    deps.getSettings.mockResolvedValue({ codexAutoPing: { connections: { "codex-1": true } } });
    deps.getProviderConnections.mockImplementation(async ({ provider }) => (
      provider === "codex" ? [{ id: "codex-1", provider: "codex", authType: "oauth", accessToken: "token" }] : []
    ));
    state.resetCache["codex:codex-1"] = "2026-01-01T17:00:00.000Z";
    getCodexUsage.mockResolvedValue({
      quotas: { session: { used: 1, total: 100, remaining: 99, resetAt: "2026-01-01T17:00:00.000Z" } },
    });

    await runQuotaAutoPingTick(deps, state);

    expect(deps.getExecutor).not.toHaveBeenCalled();
    expect(deps.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("does not repeat Codex ping inside the minimum ping interval", async () => {
    deps.getSettings.mockResolvedValue({ codexAutoPing: { connections: { "codex-1": true } } });
    deps.getProviderConnections.mockImplementation(async ({ provider }) => (
      provider === "codex"
        ? [{ id: "codex-1", provider: "codex", authType: "oauth", accessToken: "token", lastPingAt: "2026-01-01T11:55:00.000Z" }]
        : []
    ));
    state.resetCache["codex:codex-1"] = "2026-01-01T17:00:00.000Z";
    getCodexUsage.mockResolvedValue({
      quotas: { session: { used: 1, total: 100, remaining: 99, resetAt: "2026-01-01T17:01:00.000Z" } },
    });

    await runQuotaAutoPingTick(deps, state);

    expect(deps.getExecutor).not.toHaveBeenCalled();
    expect(deps.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("does not ping Codex just because reported usage is zero", async () => {
    deps.getSettings.mockResolvedValue({ codexAutoPing: { connections: { "codex-1": true } } });
    deps.getProviderConnections.mockImplementation(async ({ provider }) => (
      provider === "codex" ? [{ id: "codex-1", provider: "codex", authType: "oauth", accessToken: "token" }] : []
    ));
    getCodexUsage.mockResolvedValue({
      quotas: { session: { used: 0, resetAt: "2026-01-01T17:00:00.000Z" } },
    });

    await runQuotaAutoPingTick(deps, state);

    expect(deps.getExecutor).not.toHaveBeenCalled();
    expect(deps.updateProviderConnection).not.toHaveBeenCalled();
    expect(state.resetCache["codex:codex-1"]).toBe("2026-01-01T17:00:00.000Z");
  });

  it("does not ping Codex when weekly quota is exhausted", async () => {
    deps.getSettings.mockResolvedValue({ codexAutoPing: { connections: { "codex-1": true } } });
    deps.getProviderConnections.mockImplementation(async ({ provider }) => (
      provider === "codex" ? [{ id: "codex-1", provider: "codex", authType: "oauth", accessToken: "token" }] : []
    ));
    state.resetCache["codex:codex-1"] = "2026-01-01T17:00:00.000Z";
    getCodexUsage.mockResolvedValue({
      quotas: {
        session: { used: 0, total: 100, remaining: 100, resetAt: "2026-01-01T17:01:00.000Z" },
        weekly: { used: 100, total: 100, remaining: 0, resetAt: "2026-01-03T12:00:00.000Z" },
      },
    });

    await runQuotaAutoPingTick(deps, state);

    expect(deps.getExecutor).not.toHaveBeenCalled();
    expect(deps.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("does not ping Codex when monthly quota is exhausted", async () => {
    deps.getSettings.mockResolvedValue({ codexAutoPing: { connections: { "codex-1": true } } });
    deps.getProviderConnections.mockImplementation(async ({ provider }) => (
      provider === "codex" ? [{ id: "codex-1", provider: "codex", authType: "oauth", accessToken: "token" }] : []
    ));
    state.resetCache["codex:codex-1"] = "2026-01-01T17:00:00.000Z";
    getCodexUsage.mockResolvedValue({
      quotas: {
        session: { used: 0, total: 100, remaining: 100, resetAt: "2026-01-01T17:01:00.000Z" },
        monthly: { used: 100, total: 100, remaining: 0, resetAt: "2026-02-01T00:00:00.000Z" },
      },
    });

    await runQuotaAutoPingTick(deps, state);

    expect(deps.getExecutor).not.toHaveBeenCalled();
    expect(deps.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("does not ping Codex when session quota is exhausted", async () => {
    deps.getSettings.mockResolvedValue({ codexAutoPing: { connections: { "codex-1": true } } });
    deps.getProviderConnections.mockImplementation(async ({ provider }) => (
      provider === "codex" ? [{ id: "codex-1", provider: "codex", authType: "oauth", accessToken: "token" }] : []
    ));
    state.resetCache["codex:codex-1"] = "2026-01-01T17:00:00.000Z";
    getCodexUsage.mockResolvedValue({
      quotas: { session: { used: 100, total: 100, remaining: 0, resetAt: "2026-01-01T17:01:00.000Z" } },
    });

    await runQuotaAutoPingTick(deps, state);

    expect(deps.getExecutor).not.toHaveBeenCalled();
    expect(deps.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("sends one tiny gpt-5.6-terra Codex request through the executor", async () => {
    deps.getSettings.mockResolvedValue({ codexAutoPing: { connections: { "codex-1": true } } });
    deps.getProviderConnections.mockImplementation(async ({ provider }) => (
      provider === "codex"
        ? [{ id: "codex-1", provider: "codex", authType: "oauth", accessToken: "token", providerSpecificData: { workspaceId: "ws-1" } }]
        : []
    ));
    state.resetCache["codex:codex-1"] = "2026-01-01T17:00:00.000Z";
    getCodexUsage.mockResolvedValue({
      quotas: { session: { used: 1, total: 100, remaining: 99, resetAt: "2026-01-01T17:01:00.000Z" } },
    });

    await runQuotaAutoPingTick(deps, state);

    const executor = deps.getExecutor.mock.results[0].value;
    expect(deps.getExecutor).toHaveBeenCalledWith("codex");
    expect(executor.execute).toHaveBeenCalledWith(expect.objectContaining({
      model: "gpt-5.6-terra",
      stream: true,
      credentials: expect.objectContaining({
        accessToken: "token",
        connectionId: "codex-1",
        providerSpecificData: { workspaceId: "ws-1" },
      }),
      body: {
        model: "gpt-5.6-terra",
        input: [{
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hi" }],
        }],
        instructions: "Reply with OK.",
        reasoning: { effort: "none", summary: "auto" },
        store: false,
        stream: true,
      },
    }));
    expect(codexResponseText).toHaveBeenCalledTimes(1);
    expect(deps.updateProviderConnection).toHaveBeenCalledWith("codex-1", expect.objectContaining({
      lastPingedResetAt: "2026-01-01T17:01:00.000Z",
      lastPingedResetKey: "2026-01-01T17:01:00.000Z",
    }));
  });

  it("does not ping same Codex reset twice when seconds drift", async () => {
    deps.getSettings.mockResolvedValue({ codexAutoPing: { connections: { "codex-1": true } } });
    deps.getProviderConnections.mockImplementation(async ({ provider }) => (
      provider === "codex"
        ? [{ id: "codex-1", provider: "codex", authType: "oauth", accessToken: "token", lastPingedResetAt: "2026-01-01T11:59:44.000Z" }]
        : []
    ));
    state.resetCache["codex:codex-1"] = "2026-01-01T11:59:44.000Z";
    getCodexUsage.mockResolvedValue({
      quotas: { session: { used: 0, total: 100, remaining: 100, resetAt: "2026-01-01T11:59:47.000Z" } },
    });

    await runQuotaAutoPingTick(deps, state);

    expect(deps.getExecutor).not.toHaveBeenCalled();
  });

  it("skips non-OAuth Codex connections", async () => {
    deps.getSettings.mockResolvedValue({ codexAutoPing: { connections: { "codex-1": true } } });
    deps.getProviderConnections.mockImplementation(async ({ provider }) => (
      provider === "codex" ? [{ id: "codex-1", provider: "codex", authType: "apikey", accessToken: "token" }] : []
    ));

    await runQuotaAutoPingTick(deps, state);

    expect(getCodexUsage).not.toHaveBeenCalled();
    expect(deps.getExecutor).not.toHaveBeenCalled();
  });

  it.each([10, 30, 54])("catches a Claude reset when the next tick is %s seconds late", async (seconds) => {
    const connection = { id: "claude-1", provider: "claude", authType: "oauth", accessToken: "token" };
    deps.getSettings.mockResolvedValue({ claudeAutoPing: { connections: { "claude-1": true } } });
    deps.getProviderConnections.mockImplementation(async ({ provider }) => provider === "claude" ? [connection] : []);
    deps.updateProviderConnection.mockImplementation(async (_id, patch) => Object.assign(connection, patch));
    getClaudeUsage.mockReset().mockResolvedValueOnce({
      quotas: { "session (5h)": { resetAt: "2026-01-01T12:00:00.000Z" } },
    }).mockResolvedValueOnce({
      quotas: { "session (5h)": { resetAt: "2026-01-01T17:00:00.000Z" } },
    }).mockResolvedValueOnce({
      quotas: { "session (5h)": { resetAt: "2026-01-01T22:00:00.000Z" } },
    });

    // A 60-second scheduler tick can miss the entire five-second lead window.
    vi.setSystemTime(new Date(`2026-01-01T11:59:${String(seconds).padStart(2, "0")}.000Z`));
    await runQuotaAutoPingTick(deps, state);
    expect(deps.proxyAwareFetch).not.toHaveBeenCalled();

    vi.setSystemTime(new Date(`2026-01-01T12:00:${String(seconds).padStart(2, "0")}.000Z`));
    await runQuotaAutoPingTick(deps, state);
    expect(deps.proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(connection.lastPingedResetAt).toBe("2026-01-01T12:00:00.000Z");
    expect(connection.lastPingedResetKey).toBe("2026-01-01T12:00:00.000Z");

    vi.setSystemTime(new Date("2026-01-01T12:01:59.000Z"));
    await runQuotaAutoPingTick(deps, state);
    expect(deps.proxyAwareFetch).toHaveBeenCalledTimes(1);

    // Catching up must not mark the *next* window as already pinged.
    vi.setSystemTime(new Date("2026-01-01T17:00:30.000Z"));
    await runQuotaAutoPingTick(deps, state);
    expect(deps.proxyAwareFetch).toHaveBeenCalledTimes(2);
    expect(connection.lastPingedResetKey).toBe("2026-01-01T17:00:00.000Z");
  });

  it.each(["HTTP error", "network error"])("retries a missed Claude reset after cooldown on %s", async (failure) => {
    deps.getSettings.mockResolvedValue({ claudeAutoPing: { connections: { "claude-1": true } } });
    deps.getProviderConnections.mockImplementation(async ({ provider }) => provider === "claude" ? [{
      id: "claude-1", provider: "claude", authType: "oauth", accessToken: "token",
    }] : []);
    state.resetCache["claude:claude-1"] = "2026-01-01T12:00:00.000Z";
    getClaudeUsage.mockReset().mockResolvedValue({
      quotas: { "session (5h)": { resetAt: "2026-01-01T17:00:00.000Z" } },
    });
    if (failure === "HTTP error") deps.proxyAwareFetch.mockResolvedValueOnce({ ok: false });
    else deps.proxyAwareFetch.mockRejectedValueOnce(new Error("connection reset"));

    vi.setSystemTime(new Date("2026-01-01T12:00:30.000Z"));
    await runQuotaAutoPingTick(deps, state);
    expect(deps.proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(deps.updateProviderConnection).not.toHaveBeenCalled();
    expect(state.resetCache["claude:claude-1"]).toBe("2026-01-01T12:00:00.000Z");

    vi.setSystemTime(new Date("2026-01-01T12:01:30.000Z"));
    await runQuotaAutoPingTick(deps, state);
    expect(deps.proxyAwareFetch).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-01-01T12:16:00.000Z"));
    await runQuotaAutoPingTick(deps, state);
    expect(deps.proxyAwareFetch).toHaveBeenCalledTimes(2);
    expect(deps.updateProviderConnection).toHaveBeenCalledWith("claude-1", expect.objectContaining({
      lastPingedResetKey: "2026-01-01T12:00:00.000Z",
    }));
    expect(state.resetCache["claude:claude-1"]).toBe("2026-01-01T17:00:00.000Z");
    expect(state.failureCache["claude:claude-1"]).toBeUndefined();
  });

  it("does not catch up a Claude reset that was already pinged", async () => {
    deps.getSettings.mockResolvedValue({ claudeAutoPing: { connections: { "claude-1": true } } });
    deps.getProviderConnections.mockImplementation(async ({ provider }) => provider === "claude" ? [{
      id: "claude-1", provider: "claude", authType: "oauth", accessToken: "token",
      lastPingedResetKey: "2026-01-01T12:00:00.000Z",
    }] : []);
    state.resetCache["claude:claude-1"] = "2026-01-01T12:00:00.000Z";
    vi.setSystemTime(new Date("2026-01-01T12:00:30.000Z"));
    getClaudeUsage.mockResolvedValue({
      quotas: { "session (5h)": { resetAt: "2026-01-01T17:00:00.000Z" } },
    });

    await runQuotaAutoPingTick(deps, state);

    expect(deps.proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("keeps Claude session quota key behavior", async () => {
    deps.getSettings.mockResolvedValue({ claudeAutoPing: { connections: { "claude-1": true } } });
    deps.getProviderConnections.mockImplementation(async ({ provider }) => (
      provider === "claude" ? [{ id: "claude-1", provider: "claude", authType: "oauth", accessToken: "token" }] : []
    ));
    getClaudeUsage.mockResolvedValue({
      quotas: { "session (5h)": { resetAt: "2026-01-01T11:59:00.000Z" } },
    });

    await runQuotaAutoPingTick(deps, state);

    expect(deps.proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(deps.proxyAwareFetch.mock.calls[0][1].body)).toMatchObject({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    });
  });

  it("pings Factory when the 5h window has expired", async () => {
    deps.getSettings.mockResolvedValue({ factoryAutoPing: { connections: { "factory-1": true } } });
    deps.getProviderConnections.mockImplementation(async ({ provider }) => (
      provider === "factory"
        ? [{ id: "factory-1", provider: "factory", authType: "oauth", accessToken: "token", providerSpecificData: { orgId: "org-1" } }]
        : []
    ));
    state.resetCache["factory:factory-1"] = "2026-01-01T11:30:00.000Z";
    getFactoryUsage.mockResolvedValue({
      quotas: { standard_5h: { used: 100, total: 100, remaining: 0, resetAt: "2026-01-01T11:30:00.000Z" } },
    });

    await runQuotaAutoPingTick(deps, state);

    expect(getFactoryUsage).toHaveBeenCalledWith("token", { orgId: "org-1" }, expect.any(Object), expect.any(AbortSignal));
    const executor = deps.getExecutor.mock.results[0].value;
    expect(deps.getExecutor).toHaveBeenCalledWith("factory");
    expect(executor.execute).toHaveBeenCalledWith(expect.objectContaining({
      model: "glm-5.3-flash",
      stream: true,
      credentials: expect.objectContaining({
        accessToken: "token",
        connectionId: "factory-1",
        providerSpecificData: { orgId: "org-1" },
      }),
      body: {
        model: "glm-5.3-flash",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1,
        stream: true,
      },
    }));
    expect(deps.updateProviderConnection).toHaveBeenCalledWith("factory-1", expect.objectContaining({
      lastPingedResetAt: "2026-01-01T11:30:00.000Z",
      lastPingedResetKey: "2026-01-01T11:30:00.000Z",
    }));
  });

  it("does not ping Factory while the 5h window is live", async () => {
    deps.getSettings.mockResolvedValue({ factoryAutoPing: { connections: { "factory-1": true } } });
    deps.getProviderConnections.mockImplementation(async ({ provider }) => (
      provider === "factory" ? [{ id: "factory-1", provider: "factory", authType: "oauth", accessToken: "token" }] : []
    ));
    getFactoryUsage.mockResolvedValue({
      quotas: { standard_5h: { used: 100, total: 100, remaining: 0, resetAt: "2026-01-01T17:00:00.000Z" } },
    });

    await runQuotaAutoPingTick(deps, state);

    expect(deps.getExecutor).not.toHaveBeenCalled();
    expect(deps.updateProviderConnection).not.toHaveBeenCalled();
    expect(state.resetCache["factory:factory-1"]).toBe("2026-01-01T17:00:00.000Z");
  });

  it("pings Factory when no window was ever started", async () => {
    deps.getSettings.mockResolvedValue({ factoryAutoPing: { connections: { "factory-1": true } } });
    deps.getProviderConnections.mockImplementation(async ({ provider }) => (
      provider === "factory" ? [{ id: "factory-1", provider: "factory", authType: "oauth", accessToken: "token" }] : []
    ));
    getFactoryUsage.mockResolvedValue({
      quotas: { standard_5h: { used: 0, total: 100, remaining: 100, resetAt: null } },
    });

    await runQuotaAutoPingTick(deps, state);

    expect(deps.getExecutor).toHaveBeenCalledTimes(1);
    expect(deps.updateProviderConnection).toHaveBeenCalledWith("factory-1", expect.objectContaining({
      lastPingedResetAt: null,
      lastPingedResetKey: null,
    }));
  });

  it("pings Factory again after the second window dies without reporting windowEnd", async () => {
    // Regression: every "no live window" report collapsed to the same epoch
    // dedup key, so only the first restart ever fired.
    deps.getSettings.mockResolvedValue({ factoryAutoPing: { connections: { "factory-1": true } } });
    const conn = { id: "factory-1", provider: "factory", authType: "oauth", accessToken: "token" };
    deps.getProviderConnections.mockImplementation(async () => [{ ...conn }]);
    getFactoryUsage.mockResolvedValue({
      quotas: { standard_5h: { used: 0, total: 100, remaining: 100, resetAt: null } },
    });

    // First observation: no live window → ping starts one.
    await runQuotaAutoPingTick(deps, state);
    expect(deps.getExecutor).toHaveBeenCalledTimes(1);

    // The started window is live → no further pings while it runs.
    vi.setSystemTime(new Date("2026-01-01T12:05:00.000Z"));
    getFactoryUsage.mockResolvedValue({
      quotas: { standard_5h: { used: 40, total: 100, remaining: 60, resetAt: "2026-01-01T17:00:00.000Z" } },
    });
    await runQuotaAutoPingTick(deps, state);
    expect(deps.getExecutor).toHaveBeenCalledTimes(1);

    // Five hours later the window dies and Factory reports no end at all → restart.
    conn.lastPingAt = "2026-01-01T12:00:30.000Z";
    vi.setSystemTime(new Date("2026-01-01T17:30:00.000Z"));
    getFactoryUsage.mockResolvedValue({
      quotas: { standard_5h: { used: 100, total: 100, remaining: 0, resetAt: null } },
    });
    await runQuotaAutoPingTick(deps, state);

    expect(deps.getExecutor).toHaveBeenCalledTimes(2);
    expect(deps.updateProviderConnection).toHaveBeenLastCalledWith("factory-1", expect.objectContaining({
      lastPingedResetAt: null,
      lastPingedResetKey: null,
    }));
  });

  it("does not catch up an expired Factory window that other usage already restarted", async () => {
    // Claude's missed-reset catch-up must not apply to Factory: Factory pings
    // only to start an inactive window, and a future windowEnd means one is live.
    deps.getSettings.mockResolvedValue({ factoryAutoPing: { connections: { "factory-1": true } } });
    deps.getProviderConnections.mockImplementation(async ({ provider }) => (
      provider === "factory" ? [{ id: "factory-1", provider: "factory", authType: "oauth", accessToken: "token" }] : []
    ));
    state.resetCache["factory:factory-1"] = "2026-01-01T11:30:00.000Z";
    getFactoryUsage.mockResolvedValue({
      quotas: { standard_5h: { used: 5, total: 100, remaining: 95, resetAt: "2026-01-01T16:50:00.000Z" } },
    });

    await runQuotaAutoPingTick(deps, state);

    expect(deps.getExecutor).not.toHaveBeenCalled();
    expect(state.resetCache["factory:factory-1"]).toBe("2026-01-01T16:50:00.000Z");
  });

  it("does not repeat a Factory ping for the same expired window", async () => {
    deps.getSettings.mockResolvedValue({ factoryAutoPing: { connections: { "factory-1": true } } });
    deps.getProviderConnections.mockImplementation(async ({ provider }) => (
      provider === "factory"
        ? [{ id: "factory-1", provider: "factory", authType: "oauth", accessToken: "token", lastPingedResetKey: "2026-01-01T11:30:00.000Z" }]
        : []
    ));
    state.resetCache["factory:factory-1"] = "2026-01-01T11:30:00.000Z";
    getFactoryUsage.mockResolvedValue({
      quotas: { standard_5h: { used: 100, total: 100, remaining: 0, resetAt: "2026-01-01T11:30:00.000Z" } },
    });

    await runQuotaAutoPingTick(deps, state);

    expect(deps.getExecutor).not.toHaveBeenCalled();
  });

  it("does not ping Factory when a weekly quota is exhausted", async () => {
    deps.getSettings.mockResolvedValue({ factoryAutoPing: { connections: { "factory-1": true } } });
    deps.getProviderConnections.mockImplementation(async ({ provider }) => (
      provider === "factory" ? [{ id: "factory-1", provider: "factory", authType: "oauth", accessToken: "token" }] : []
    ));
    getFactoryUsage.mockResolvedValue({
      quotas: {
        standard_5h: { used: 100, total: 100, remaining: 0, resetAt: "2026-01-01T11:30:00.000Z" },
        standard_weekly: { used: 100, total: 100, remaining: 0, resetAt: "2026-01-05T00:00:00.000Z" },
      },
    });

    await runQuotaAutoPingTick(deps, state);

    expect(deps.getExecutor).not.toHaveBeenCalled();
  });

  it("pings Factory when only the core 5h window is exhausted", async () => {
    deps.getSettings.mockResolvedValue({ factoryAutoPing: { connections: { "factory-1": true } } });
    deps.getProviderConnections.mockImplementation(async ({ provider }) => (
      provider === "factory" ? [{ id: "factory-1", provider: "factory", authType: "oauth", accessToken: "token" }] : []
    ));
    getFactoryUsage.mockResolvedValue({
      quotas: {
        standard_5h: { used: 100, total: 100, remaining: 0, resetAt: "2026-01-01T11:30:00.000Z" },
        core_5h: { used: 100, total: 100, remaining: 0, resetAt: "2026-01-01T12:30:00.000Z" },
      },
    });

    await runQuotaAutoPingTick(deps, state);

    expect(deps.getExecutor).toHaveBeenCalledTimes(1);
  });

  describe("anchored schedule", () => {
    const schedule = {
      enabled: true,
      anchor: "09:30",
      timezone: "America/Sao_Paulo",
      windowHours: 5,
      slotsPerDay: 3,
    };

    const codexConnection = (extra = {}) => ({
      id: "codex-1", provider: "codex", authType: "oauth", accessToken: "token", ...extra,
    });

    const settingsWithSchedule = (overrides = {}) => ({
      codexAutoPing: {
        connections: { "codex-1": true },
        schedules: { "codex-1": { ...schedule, ...overrides } },
      },
    });

    let connection = codexConnection();

    beforeEach(() => {
      connection = codexConnection();
      deps.getProviderConnections.mockImplementation(async ({ provider }) => (
        provider === "codex" ? [connection] : []
      ));
    });

    it("pings on the 09:30 BRT slot even when resetAt is stable", async () => {
      // 12:31 UTC = 09:31 BRT — the reactive path alone would stay quiet here.
      vi.setSystemTime(new Date("2026-08-20T12:31:00.000Z"));
      deps.getSettings.mockResolvedValue(settingsWithSchedule());
      state.resetCache["codex:codex-1"] = "2026-08-20T20:00:00.000Z";
      getCodexUsage.mockResolvedValue({
        quotas: { session: { used: 1, total: 100, remaining: 99, resetAt: "2026-08-20T20:00:00.000Z" } },
      });

      await runQuotaAutoPingTick(deps, state);

      expect(deps.getExecutor).toHaveBeenCalledTimes(1);
      expect(deps.updateProviderConnection).toHaveBeenCalledWith("codex-1", expect.objectContaining({
        lastPingedSlotKey: "2026-08-20#0",
      }));
    });

    it("does not repeat a slot that was already pinged", async () => {
      vi.setSystemTime(new Date("2026-08-20T12:31:00.000Z"));
      connection = codexConnection({ lastPingedSlotKey: "2026-08-20#0" });
      deps.getSettings.mockResolvedValue(settingsWithSchedule());
      state.resetCache["codex:codex-1"] = "2026-08-20T20:00:00.000Z";
      getCodexUsage.mockResolvedValue({
        quotas: { session: { used: 1, total: 100, remaining: 99, resetAt: "2026-08-20T20:00:00.000Z" } },
      });

      await runQuotaAutoPingTick(deps, state);

      expect(deps.getExecutor).not.toHaveBeenCalled();
    });

    it("stays quiet overnight", async () => {
      // 06:00 UTC = 03:00 BRT, outside every slot.
      vi.setSystemTime(new Date("2026-08-20T06:00:00.000Z"));
      deps.getSettings.mockResolvedValue(settingsWithSchedule());
      state.resetCache["codex:codex-1"] = "2026-08-20T20:00:00.000Z";
      getCodexUsage.mockResolvedValue({
        quotas: { session: { used: 1, total: 100, remaining: 99, resetAt: "2026-08-20T20:00:00.000Z" } },
      });

      await runQuotaAutoPingTick(deps, state);

      expect(deps.getExecutor).not.toHaveBeenCalled();
    });

    it("keeps the reactive ping working alongside the schedule", async () => {
      vi.setSystemTime(new Date("2026-08-20T06:00:00.000Z"));
      deps.getSettings.mockResolvedValue(settingsWithSchedule());
      state.resetCache["codex:codex-1"] = "2026-08-20T20:00:00.000Z";
      getCodexUsage.mockResolvedValue({
        quotas: { session: { used: 1, total: 100, remaining: 99, resetAt: "2026-08-20T20:01:00.000Z" } },
      });

      await runQuotaAutoPingTick(deps, state);

      expect(deps.getExecutor).toHaveBeenCalledTimes(1);
      expect(deps.updateProviderConnection).toHaveBeenCalledWith("codex-1", expect.not.objectContaining({
        lastPingedSlotKey: expect.anything(),
      }));
    });

    it("ignores a disabled schedule", async () => {
      vi.setSystemTime(new Date("2026-08-20T12:31:00.000Z"));
      deps.getSettings.mockResolvedValue(settingsWithSchedule({ enabled: false }));
      state.resetCache["codex:codex-1"] = "2026-08-20T20:00:00.000Z";
      getCodexUsage.mockResolvedValue({
        quotas: { session: { used: 1, total: 100, remaining: 99, resetAt: "2026-08-20T20:00:00.000Z" } },
      });

      await runQuotaAutoPingTick(deps, state);

      expect(deps.getExecutor).not.toHaveBeenCalled();
    });

    it("pings Claude on a slot before its reset is due", async () => {
      vi.setSystemTime(new Date("2026-08-20T12:31:00.000Z"));
      deps.getSettings.mockResolvedValue({
        claudeAutoPing: {
          connections: { "claude-1": true },
          schedules: { "claude-1": schedule },
        },
      });
      deps.getProviderConnections.mockImplementation(async ({ provider }) => (
        provider === "claude" ? [{ id: "claude-1", provider: "claude", authType: "oauth", accessToken: "token" }] : []
      ));
      state.resetCache["claude:claude-1"] = "2026-08-20T23:00:00.000Z";
      getClaudeUsage.mockResolvedValue({
        quotas: { "session (5h)": { resetAt: "2026-08-20T23:00:00.000Z" } },
      });

      await runQuotaAutoPingTick(deps, state);

      expect(deps.proxyAwareFetch).toHaveBeenCalledTimes(1);
      expect(deps.updateProviderConnection).toHaveBeenCalledWith("claude-1", expect.objectContaining({
        lastPingedSlotKey: "2026-08-20#0",
      }));
    });

    it("runs a schedule on a connection with the reactive ping switched off", async () => {
      vi.setSystemTime(new Date("2026-08-20T12:31:00.000Z"));
      deps.getSettings.mockResolvedValue({
        codexAutoPing: {
          connections: { "codex-1": false },
          schedules: { "codex-1": schedule },
        },
      });
      state.resetCache["codex:codex-1"] = "2026-08-20T20:00:00.000Z";
      getCodexUsage.mockResolvedValue({
        quotas: { session: { used: 1, total: 100, remaining: 99, resetAt: "2026-08-20T20:00:00.000Z" } },
      });

      await runQuotaAutoPingTick(deps, state);

      expect(deps.getExecutor).toHaveBeenCalledTimes(1);
      expect(deps.updateProviderConnection).toHaveBeenCalledWith("codex-1", expect.objectContaining({
        lastPingedSlotKey: "2026-08-20#0",
      }));
    });

    it("does not fall back to the reactive ping when only the schedule is on", async () => {
      // resetAt slides, which is exactly what the reactive Codex path pings on.
      vi.setSystemTime(new Date("2026-08-20T06:00:00.000Z"));
      deps.getSettings.mockResolvedValue({
        codexAutoPing: {
          connections: { "codex-1": false },
          schedules: { "codex-1": schedule },
        },
      });
      state.resetCache["codex:codex-1"] = "2026-08-20T20:00:00.000Z";
      getCodexUsage.mockResolvedValue({
        quotas: { session: { used: 1, total: 100, remaining: 99, resetAt: "2026-08-20T20:01:00.000Z" } },
      });

      await runQuotaAutoPingTick(deps, state);

      expect(deps.getExecutor).not.toHaveBeenCalled();
    });

    it("needs the scheduler running for a schedule alone", async () => {
      const { hasAnyAutoPingEnabled } = await import("../../src/shared/services/quotaAutoPing.js");

      expect(hasAnyAutoPingEnabled({ codexAutoPing: { connections: { "codex-1": false } } })).toBe(false);
      expect(hasAnyAutoPingEnabled({
        codexAutoPing: { connections: { "codex-1": false }, schedules: { "codex-1": schedule } },
      })).toBe(true);
      expect(hasAnyAutoPingEnabled({
        codexAutoPing: { connections: {}, schedules: { "codex-1": { ...schedule, enabled: false } } },
      })).toBe(false);
    });

    it("skips the slot when the quota is exhausted", async () => {
      vi.setSystemTime(new Date("2026-08-20T12:31:00.000Z"));
      deps.getSettings.mockResolvedValue(settingsWithSchedule());
      getCodexUsage.mockResolvedValue({
        quotas: { session: { used: 100, total: 100, remaining: 0, resetAt: "2026-08-20T20:00:00.000Z" } },
      });

      await runQuotaAutoPingTick(deps, state);

      expect(deps.getExecutor).not.toHaveBeenCalled();
    });
  });

  describe("concurrency, isolation, cancellation, and quota policy regressions", () => {
    it("allows Factory to ping promptly when Codex stream stalls", async () => {
      vi.useFakeTimers();
      deps.getSettings.mockResolvedValue({
        codexAutoPing: { connections: { "codex-1": true } },
        factoryAutoPing: { connections: { "factory-1": true } },
      });
      deps.getProviderConnections.mockImplementation(async ({ provider }) => {
        if (provider === "codex") {
          return [{ id: "codex-1", provider: "codex", authType: "oauth", accessToken: "token-codex" }];
        }
        if (provider === "factory") {
          return [{ id: "factory-1", provider: "factory", authType: "oauth", accessToken: "token-factory", providerSpecificData: { orgId: "org-1" } }];
        }
        return [];
      });

      state.resetCache["codex:codex-1"] = "2026-01-01T17:00:00.000Z";
      getCodexUsage.mockResolvedValue({
        quotas: { session: { used: 1, total: 100, remaining: 99, resetAt: "2026-01-01T17:01:00.000Z" } },
      });

      state.resetCache["factory:factory-1"] = "2026-01-01T11:30:00.000Z";
      getFactoryUsage.mockResolvedValue({
        quotas: { standard_5h: { used: 100, total: 100, remaining: 0, resetAt: "2026-01-01T11:30:00.000Z" } },
      });

      let streamController;
      const stalledStream = new ReadableStream({
        start(controller) {
          streamController = controller;
        },
      });

      const codexExecutor = {
        execute: vi.fn().mockResolvedValue({
          response: {
            ok: true,
            body: stalledStream,
          },
        }),
      };

      const factoryExecutor = {
        execute: vi.fn().mockResolvedValue({
          response: {
            ok: true,
            text: vi.fn().mockResolvedValue("ok"),
          },
        }),
      };

      deps.getExecutor.mockImplementation((provider) => {
        if (provider === "codex") return codexExecutor;
        if (provider === "factory") return factoryExecutor;
        return { execute: vi.fn() };
      });

      let tickPromise;
      try {
        tickPromise = runQuotaAutoPingTick(deps, state);

        // Allow microtasks to execute
        for (let i = 0; i < 20; i++) await Promise.resolve();
        // Factory ping MUST have executed promptly even while Codex stream is stalled
        expect(factoryExecutor.execute).toHaveBeenCalledTimes(1);
        expect(deps.updateProviderConnection).toHaveBeenCalledWith("factory-1", expect.objectContaining({
          lastPingedResetAt: "2026-01-01T11:30:00.000Z",
        }));
      } finally {
        try { streamController?.close(); } catch {}
        await vi.advanceTimersByTimeAsync(60001);
        if (tickPromise) await tickPromise.catch(() => {});
      }
    });

    it("never allows the same connection to overlap across concurrent ticks while permitting free accounts to proceed", async () => {
      deps.getSettings.mockResolvedValue({
        codexAutoPing: { connections: { "codex-1": true, "codex-2": true } },
      });
      deps.getProviderConnections.mockResolvedValue([
        { id: "codex-1", provider: "codex", authType: "oauth", accessToken: "token-1" },
        { id: "codex-2", provider: "codex", authType: "oauth", accessToken: "token-2" },
      ]);

      state.resetCache["codex:codex-1"] = "2026-01-01T17:00:00.000Z";
      state.resetCache["codex:codex-2"] = "2026-01-01T17:00:00.000Z";
      getCodexUsage.mockImplementation(async () => ({
        quotas: { session: { used: 1, total: 100, remaining: 99, resetAt: "2026-01-01T17:01:00.000Z" } },
      }));

      let resolveConn1Started;
      const conn1Started = new Promise((resolve) => { resolveConn1Started = resolve; });

      let resolveConn1Blocked;
      const conn1Blocked = new Promise((resolve) => { resolveConn1Blocked = resolve; });

      const executedConns = [];
      deps.getExecutor.mockReturnValue({
        execute: vi.fn().mockImplementation(async ({ credentials }) => {
          executedConns.push(credentials.connectionId);
          if (credentials.connectionId === "codex-1") {
            resolveConn1Started();
            await conn1Blocked;
          }
          return { response: { ok: true, text: vi.fn().mockResolvedValue("ok") } };
        }),
      });

      let tick1;
      let tick2;
      try {
        // Tick 1 runs; wait until codex-1 is inside execute
        tick1 = runQuotaAutoPingTick(deps, state);
        await conn1Started;

        // Tick 2 runs while codex-1 is in-flight
        tick2 = runQuotaAutoPingTick(deps, state);
        await tick2;

        // codex-1 should only have been started once across both ticks
        expect(executedConns.filter((id) => id === "codex-1").length).toBe(1);
        // Free account codex-2 should have been executed
        expect(executedConns).toContain("codex-2");
      } finally {
        resolveConn1Blocked?.();
        if (tick1) await tick1.catch(() => {});
        if (tick2) await tick2.catch(() => {});
      }

      expect(executedConns.filter((id) => id === "codex-1").length).toBe(1);
    });

    it("aborts stalled attempt after timeout and ignores late success from uncooperative transport", async () => {
      vi.useFakeTimers();
      deps.getSettings.mockResolvedValue({
        codexAutoPing: { connections: { "codex-1": true } },
      });
      deps.getProviderConnections.mockResolvedValue([
        { id: "codex-1", provider: "codex", authType: "oauth", accessToken: "token-1" },
      ]);

      state.resetCache["codex:codex-1"] = "2026-01-01T17:00:00.000Z";
      getCodexUsage.mockResolvedValue({
        quotas: { session: { used: 1, total: 100, remaining: 99, resetAt: "2026-01-01T17:01:00.000Z" } },
      });

      let capturedSignal;
      let resolveExecute;
      const executePromise = new Promise((resolve) => {
        resolveExecute = resolve;
      });

      deps.getExecutor.mockReturnValue({
        execute: vi.fn().mockImplementation(async (opts) => {
          capturedSignal = opts.signal;
          await executePromise;
          return { response: { ok: true, text: vi.fn().mockResolvedValue("ok") } };
        }),
      });

      let tickPromise;
      try {
        tickPromise = runQuotaAutoPingTick(deps, state);

        // Advance time past the 60s attempt timeout
        await vi.advanceTimersByTimeAsync(60001);

        // The signal passed to executor must be aborted
        expect(capturedSignal?.aborted).toBe(true);

        // Uncooperative transport finishes LATE after abort
        resolveExecute();
        await tickPromise;

        // Stalled work must NOT persist success
        expect(deps.updateProviderConnection).not.toHaveBeenCalled();
      } finally {
        resolveExecute?.();
        if (tickPromise) await tickPromise.catch(() => {});
      }
    });

    it("continues to scan other providers when enumeration fails in one provider", async () => {
      deps.getSettings.mockResolvedValue({
        codexAutoPing: { connections: { "codex-1": true } },
        factoryAutoPing: { connections: { "factory-1": true } },
      });

      deps.getProviderConnections.mockImplementation(async ({ provider }) => {
        if (provider === "codex") {
          throw new Error("DB enumeration error for codex");
        }
        if (provider === "factory") {
          return [{ id: "factory-1", provider: "factory", authType: "oauth", accessToken: "token-factory", providerSpecificData: { orgId: "org-1" } }];
        }
        return [];
      });

      state.resetCache["factory:factory-1"] = "2026-01-01T11:30:00.000Z";
      getFactoryUsage.mockResolvedValue({
        quotas: { standard_5h: { used: 100, total: 100, remaining: 0, resetAt: "2026-01-01T11:30:00.000Z" } },
      });

      const factoryExecutor = {
        execute: vi.fn().mockResolvedValue({
          response: { ok: true, text: vi.fn().mockResolvedValue("ok") },
        }),
      };
      deps.getExecutor.mockImplementation((provider) => {
        if (provider === "factory") return factoryExecutor;
        return { execute: vi.fn() };
      });

      await runQuotaAutoPingTick(deps, state);

      expect(deps.getProviderConnections).toHaveBeenCalledWith({ provider: "factory", isActive: true });
      expect(factoryExecutor.execute).toHaveBeenCalledTimes(1);
      expect(deps.updateProviderConnection).toHaveBeenCalledWith("factory-1", expect.objectContaining({
        lastPingedResetAt: "2026-01-01T11:30:00.000Z",
      }));
    });

    it("does not suppress Codex ping when unrelated review or spark quota is exhausted", async () => {
      deps.getSettings.mockResolvedValue({ codexAutoPing: { connections: { "codex-1": true } } });
      deps.getProviderConnections.mockResolvedValue([
        { id: "codex-1", provider: "codex", authType: "oauth", accessToken: "token-1" },
      ]);
      state.resetCache["codex:codex-1"] = "2026-01-01T17:00:00.000Z";
      getCodexUsage.mockResolvedValue({
        quotas: {
          session: { used: 1, total: 100, remaining: 99, resetAt: "2026-01-01T17:01:00.000Z" },
          review_weekly: { used: 100, total: 100, remaining: 0 },
          spark_weekly: { used: 100, total: 100, remaining: 0 },
        },
      });

      const executor = { execute: vi.fn().mockResolvedValue({ response: { ok: true, text: vi.fn().mockResolvedValue("ok") } }) };
      deps.getExecutor.mockReturnValue(executor);

      await runQuotaAutoPingTick(deps, state);

      expect(executor.execute).toHaveBeenCalledTimes(1);
      expect(deps.updateProviderConnection).toHaveBeenCalledWith("codex-1", expect.objectContaining({
        lastPingedResetAt: "2026-01-01T17:01:00.000Z",
      }));
    });

    it("does not suppress Factory ping when unrelated Core quotas are exhausted", async () => {
      deps.getSettings.mockResolvedValue({ factoryAutoPing: { connections: { "factory-1": true } } });
      deps.getProviderConnections.mockResolvedValue([
        { id: "factory-1", provider: "factory", authType: "oauth", accessToken: "token-1", providerSpecificData: { orgId: "org-1" } },
      ]);
      state.resetCache["factory:factory-1"] = "2026-01-01T11:30:00.000Z";
      getFactoryUsage.mockResolvedValue({
        quotas: {
          standard_5h: { used: 100, total: 100, remaining: 0, resetAt: "2026-01-01T11:30:00.000Z" },
          core_weekly: { used: 100, total: 100, remaining: 0 },
          core_monthly: { used: 100, total: 100, remaining: 0 },
        },
      });

      const executor = { execute: vi.fn().mockResolvedValue({ response: { ok: true, text: vi.fn().mockResolvedValue("ok") } }) };
      deps.getExecutor.mockReturnValue(executor);

      await runQuotaAutoPingTick(deps, state);

      expect(executor.execute).toHaveBeenCalledTimes(1);
      expect(deps.updateProviderConnection).toHaveBeenCalledWith("factory-1", expect.objectContaining({
        lastPingedResetAt: "2026-01-01T11:30:00.000Z",
      }));
    });

    it("stops waiting on slow refresh without continuing aborted ping or breaking credential persistence", async () => {
      vi.useFakeTimers();
      deps.getSettings.mockResolvedValue({
        codexAutoPing: { connections: { "codex-1": true } },
      });
      deps.getProviderConnections.mockResolvedValue([
        { id: "codex-1", provider: "codex", authType: "oauth", accessToken: "token-1" },
      ]);

      let refreshResolved = false;
      let resolveRefresh;
      const refreshPromise = new Promise((resolve) => {
        resolveRefresh = () => {
          refreshResolved = true;
          resolve({ connection: { id: "codex-1", provider: "codex", accessToken: "rotated-token" }, refreshed: true });
        };
      });
      deps.refreshAndUpdateCredentials.mockImplementation(() => refreshPromise);

      let tickPromise;
      try {
        tickPromise = runQuotaAutoPingTick(deps, state);

        // Advance time past attempt timeout
        await vi.advanceTimersByTimeAsync(60001);
        await tickPromise;

        // Usage and Executor should not be called since refresh timed out
        expect(getCodexUsage).not.toHaveBeenCalled();
        expect(deps.getExecutor).not.toHaveBeenCalled();

        // Refresh itself safely resolves later in background
        resolveRefresh();
        await refreshPromise;
        expect(refreshResolved).toBe(true);

        // The aborted ping must not continue or persist a late ping marker
        expect(deps.updateProviderConnection).not.toHaveBeenCalled();
      } finally {
        resolveRefresh?.();
        if (tickPromise) await tickPromise.catch(() => {});
      }
    });

    it("releases provider scan lock after enumeration so a free account succeeds on next tick while first account is hung", async () => {
      let codexConnections = [
        { id: "codex-1", provider: "codex", authType: "oauth", accessToken: "token-1" },
      ];
      deps.getSettings.mockResolvedValue({
        codexAutoPing: { connections: { "codex-1": true, "codex-2": true } },
      });
      deps.getProviderConnections.mockImplementation(async ({ provider }) => (
        provider === "codex" ? [...codexConnections] : []
      ));

      state.resetCache["codex:codex-1"] = "2026-01-01T17:00:00.000Z";
      state.resetCache["codex:codex-2"] = "2026-01-01T17:00:00.000Z";
      getCodexUsage.mockResolvedValue({
        quotas: { session: { used: 1, total: 100, remaining: 99, resetAt: "2026-01-01T17:01:00.000Z" } },
      });

      let resolveConn1Blocked;
      const conn1Blocked = new Promise((resolve) => { resolveConn1Blocked = resolve; });

      const executedConns = [];
      deps.getExecutor.mockReturnValue({
        execute: vi.fn().mockImplementation(async ({ credentials }) => {
          executedConns.push(credentials.connectionId);
          if (credentials.connectionId === "codex-1") {
            await conn1Blocked;
          }
          return { response: { ok: true, text: vi.fn().mockResolvedValue("ok") } };
        }),
      });

      let tick1;
      let tick2;
      try {
        // Tick 1 runs with codex-1, which hangs in execute
        tick1 = runQuotaAutoPingTick(deps, state);
        for (let i = 0; i < 20; i++) await Promise.resolve();

        // While codex-1 is still hung in Tick 1, codex-2 becomes available on Tick 2
        codexConnections.push({ id: "codex-2", provider: "codex", authType: "oauth", accessToken: "token-2" });

        // Tick 2 runs: scan lock must NOT be held by codex-1's running attempt!
        tick2 = runQuotaAutoPingTick(deps, state);
        await tick2;

        // codex-2 should have been executed on tick 2!
        expect(executedConns).toContain("codex-2");
      } finally {
        resolveConn1Blocked?.();
        if (tick1) await tick1.catch(() => {});
        if (tick2) await tick2.catch(() => {});
      }
    });

    it("settles tick by 60s timeout before uncooperative execute finishes, retains account lock until settle, and suppresses late success", async () => {
      vi.useFakeTimers();
      deps.getSettings.mockResolvedValue({
        codexAutoPing: { connections: { "codex-1": true, "codex-2": true } },
      });
      deps.getProviderConnections.mockResolvedValue([
        { id: "codex-1", provider: "codex", authType: "oauth", accessToken: "token-1" },
        { id: "codex-2", provider: "codex", authType: "oauth", accessToken: "token-2" },
      ]);

      state.resetCache["codex:codex-1"] = "2026-01-01T17:00:00.000Z";
      state.resetCache["codex:codex-2"] = "2026-01-01T17:00:00.000Z";
      getCodexUsage.mockResolvedValue({
        quotas: { session: { used: 1, total: 100, remaining: 99, resetAt: "2026-01-01T17:01:00.000Z" } },
      });

      let resolveUncooperativeExecute;
      const uncooperativePromise = new Promise((resolve) => {
        resolveUncooperativeExecute = resolve;
      });

      let responseCancelCalled = false;
      const uncooperativeResponse = {
        ok: true,
        text: vi.fn().mockResolvedValue("ok"),
        body: {
          cancel: vi.fn().mockImplementation(async () => {
            responseCancelCalled = true;
          }),
        },
      };

      let codex1ExecuteCount = 0;
      let codex2ExecuteCount = 0;
      deps.getExecutor.mockReturnValue({
        execute: vi.fn().mockImplementation(async ({ credentials }) => {
          if (credentials.connectionId === "codex-1") {
            codex1ExecuteCount++;
            await uncooperativePromise;
            return { response: uncooperativeResponse };
          }
          if (credentials.connectionId === "codex-2") {
            codex2ExecuteCount++;
            return { response: { ok: true, text: vi.fn().mockResolvedValue("ok") } };
          }
          return { response: { ok: true, text: vi.fn().mockResolvedValue("ok") } };
        }),
      });

      let tick1;
      let tick2;
      try {
        tick1 = runQuotaAutoPingTick(deps, state);

        // Advance 60s: attempt timeout fires
        await vi.advanceTimersByTimeAsync(60001);

        // Tick 1 MUST settle within 60s even though execute is still unresolved!
        let tick1Settled = false;
        tick1.then(() => { tick1Settled = true; });
        for (let i = 0; i < 20; i++) await Promise.resolve();
        expect(tick1Settled).toBe(true);

        // codex-1 account lock must still be retained because uncooperative operation is still pending in background
        expect(state.inFlightConnections.has("codex:codex-1")).toBe(true);

        // Tick 2 runs: must NOT restart codex-1 (no overlap), but free accounts can proceed
        tick2 = runQuotaAutoPingTick(deps, state);
        await tick2;
        expect(codex1ExecuteCount).toBe(1);
        expect(codex2ExecuteCount).toBe(1);

        // Now the uncooperative execute finally resolves late
        resolveUncooperativeExecute();
        for (let i = 0; i < 20; i++) await Promise.resolve();

        // Late response must not persist success
        expect(deps.updateProviderConnection).not.toHaveBeenCalledWith("codex-1", expect.anything());

        // Account lock is released after background settle
        expect(state.inFlightConnections.has("codex:codex-1")).toBe(false);
      } finally {
        resolveUncooperativeExecute?.();
        if (tick1) await tick1.catch(() => {});
        if (tick2) await tick2.catch(() => {});
      }
    });

    it("records failureCache on timeout, blocks immediate retry during 15m cooldown, and succeeds after cooldown expires", async () => {
      vi.useFakeTimers();
      deps.getSettings.mockResolvedValue({
        codexAutoPing: { connections: { "codex-1": true } },
      });
      deps.getProviderConnections.mockResolvedValue([
        { id: "codex-1", provider: "codex", authType: "oauth", accessToken: "token-1" },
      ]);
      state.resetCache["codex:codex-1"] = "2026-01-01T17:00:00.000Z";

      let usageCount = 0;
      let resolveStalledUsage;
      const usagePromise = new Promise((resolve) => {
        resolveStalledUsage = resolve;
      });

      getCodexUsage.mockImplementation(async (token, proxyOptions, signal) => {
        usageCount++;
        if (usageCount === 1) {
          signal?.addEventListener?.("abort", () => resolveStalledUsage());
          await usagePromise;
          const err = new Error("This operation was aborted");
          err.name = "AbortError";
          throw err;
        }
        return {
          quotas: { session: { used: 1, total: 100, remaining: 99, resetAt: "2026-01-01T17:01:00.000Z" } },
        };
      });

      const executor = { execute: vi.fn().mockResolvedValue({ response: { ok: true, text: vi.fn().mockResolvedValue("ok") } }) };
      deps.getExecutor.mockReturnValue(executor);

      let tick1;
      let tick2;
      let tick3;
      try {
        tick1 = runQuotaAutoPingTick(deps, state);

        // Advance 60s: attempt timeout fires
        await vi.advanceTimersByTimeAsync(60001);
        await tick1;

        // failureCache must be recorded on timeout!
        expect(state.failureCache["codex:codex-1"]).toBeTypeOf("number");

        // Immediate subsequent tick (1 minute later, within 15m cooldown)
        await vi.advanceTimersByTimeAsync(60000);
        tick2 = runQuotaAutoPingTick(deps, state);
        await tick2;

        // Retry must be blocked by cooldown (usageCount remains 1)
        expect(usageCount).toBe(1);

        // Advance past 15m failureCooldownMs (900000ms total from failure)
        await vi.advanceTimersByTimeAsync(900000);
        tick3 = runQuotaAutoPingTick(deps, state);
        await tick3;

        // Usage and ping succeed after cooldown
        expect(usageCount).toBe(2);
        expect(executor.execute).toHaveBeenCalledTimes(1);
        expect(deps.updateProviderConnection).toHaveBeenCalledWith("codex-1", expect.objectContaining({
          lastPingedResetAt: "2026-01-01T17:01:00.000Z",
        }));
      } finally {
        resolveStalledUsage?.();
        if (tick1) await tick1.catch(() => {});
        if (tick2) await tick2.catch(() => {});
        if (tick3) await tick3.catch(() => {});
      }
    });

    it("cancels response body stream on abort and suppresses success marker", async () => {
      vi.useFakeTimers();
      deps.getSettings.mockResolvedValue({
        codexAutoPing: { connections: { "codex-1": true } },
      });
      deps.getProviderConnections.mockResolvedValue([
        { id: "codex-1", provider: "codex", authType: "oauth", accessToken: "token-1" },
      ]);
      state.resetCache["codex:codex-1"] = "2026-01-01T17:00:00.000Z";
      getCodexUsage.mockResolvedValue({
        quotas: { session: { used: 1, total: 100, remaining: 99, resetAt: "2026-01-01T17:01:00.000Z" } },
      });

      let readerCancelCalled = false;
      let streamController;
      const stream = new ReadableStream({
        start(controller) { streamController = controller; },
        cancel() { readerCancelCalled = true; },
      });

      // A real Response has BOTH .text() and .body
      const realResponseLike = {
        ok: true,
        text: vi.fn().mockResolvedValue("stream-text-body"),
        body: stream,
      };

      deps.getExecutor.mockReturnValue({
        execute: vi.fn().mockResolvedValue({ response: realResponseLike }),
      });

      let tickPromise;
      try {
        tickPromise = runQuotaAutoPingTick(deps, state);

        // Advance 60s to trigger abort
        await vi.advanceTimersByTimeAsync(60001);
        await tickPromise;

        // Body stream cancellation must have been triggered on abort and no success recorded
        expect(readerCancelCalled).toBe(true);
        expect(deps.updateProviderConnection).not.toHaveBeenCalled();
      } finally {
        try { streamController?.close(); } catch {}
        if (tickPromise) await tickPromise.catch(() => {});
      }
    });
  });
});
