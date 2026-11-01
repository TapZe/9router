import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  configureQuotaAutoPing: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json(body, init = {}) {
      return new Response(JSON.stringify(body), {
        status: init.status || 200,
        headers: {
          "Content-Type": "application/json",
          ...(init.headers || {}),
        },
      });
    },
  },
}));

vi.mock("@/shared/services/quotaAutoPing", () => ({
  configureQuotaAutoPing: mocks.configureQuotaAutoPing,
}));

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
const shutdownEvents = ["beforeExit", "SIGINT", "SIGTERM", "exit"];
let originalListeners;

beforeEach(async () => {
  originalListeners = new Map(shutdownEvents.map((event) => [event, new Set(process.listeners(event))]));
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-autoping-test-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  mocks.configureQuotaAutoPing.mockClear();

  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterEach(() => {
  try {
    global._dbAdapter?.instance?.close?.();
  } catch {}
  delete global._dbAdapter;
  // Reloaded adapters register process hooks that close() does not unregister.
  for (const event of shutdownEvents) {
    for (const listener of process.listeners(event)) {
      if (!originalListeners.get(event).has(listener)) process.off(event, listener);
    }
  }
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  if (originalDataDir === undefined) {
    delete process.env.DATA_DIR;
  } else {
    process.env.DATA_DIR = originalDataDir;
  }
});

describe("auto-ping settings repository & route regressions", () => {
  it("update of one account preserves siblings and unknown provider config fields", async () => {
    const { updateAccountAutoPing } = await import("@/lib/db/index.js");

    const conn1 = await db.createProviderConnection({
      provider: "factory",
      authType: "oauth",
      email: "acc1@factory.com",
    });
    const conn2 = await db.createProviderConnection({
      provider: "factory",
      authType: "oauth",
      email: "acc2@factory.com",
    });

    await db.updateSettings({
      factoryAutoPing: {
        enabled: true,
        customExtraField: "custom-value-123",
        connections: {
          [conn1.id]: true,
          [conn2.id]: false,
        },
        schedules: {
          [conn1.id]: {
            enabled: true,
            anchor: "09:30",
            timezone: "UTC",
            windowHours: 5,
            slotsPerDay: 3,
          },
          [conn2.id]: {
            enabled: false,
          },
        },
      },
    });

    const { config, settings } = await updateAccountAutoPing({
      provider: "factory",
      connectionId: conn1.id,
      reactive: false,
      schedule: null,
    });

    // Check returned provider config
    expect(config.connections[conn1.id]).toBe(false);
    expect(config.schedules[conn1.id]).toBeNull();
    expect(config.connections[conn2.id]).toBe(false);
    expect(config.schedules[conn2.id]).toEqual({ enabled: false });
    expect(config.customExtraField).toBe("custom-value-123");
    expect(config.enabled).toBe(true);

    // Verify fullSettings returned
    expect(settings.factoryAutoPing.connections[conn1.id]).toBe(false);

    // Verify DB persistence
    const saved = await db.getSettings();
    expect(saved.factoryAutoPing.connections[conn1.id]).toBe(false);
    expect(saved.factoryAutoPing.schedules[conn1.id]).toBeNull();
    expect(saved.factoryAutoPing.connections[conn2.id]).toBe(false);
    expect(saved.factoryAutoPing.schedules[conn2.id]).toEqual({ enabled: false });
    expect(saved.factoryAutoPing.customExtraField).toBe("custom-value-123");
  });

  it("different providers are preserved when updating an account", async () => {
    const { updateAccountAutoPing } = await import("@/lib/db/index.js");

    const codexConn = await db.createProviderConnection({
      provider: "codex",
      authType: "oauth",
      email: "user@codex.com",
    });
    const claudeConn = await db.createProviderConnection({
      provider: "claude",
      authType: "oauth",
      email: "user@claude.com",
    });
    const factoryConn = await db.createProviderConnection({
      provider: "factory",
      authType: "oauth",
      email: "user@factory.com",
    });

    await db.updateSettings({
      codexAutoPing: {
        connections: { [codexConn.id]: true },
        schedules: { [codexConn.id]: { enabled: true, anchor: "10:00", timezone: "UTC", windowHours: 5, slotsPerDay: 4 } },
      },
      claudeAutoPing: {
        connections: { [claudeConn.id]: true },
      },
    });

    await updateAccountAutoPing({
      provider: "factory",
      connectionId: factoryConn.id,
      reactive: true,
      schedule: null,
    });

    const saved = await db.getSettings();
    expect(saved.factoryAutoPing.connections[factoryConn.id]).toBe(true);
    // Other providers must remain completely untouched
    expect(saved.codexAutoPing.connections[codexConn.id]).toBe(true);
    expect(saved.codexAutoPing.schedules[codexConn.id].anchor).toBe("10:00");
    expect(saved.claudeAutoPing.connections[claudeConn.id]).toBe(true);
  });

  it("concurrent/stale account saves preserve both opt-ins and schedules", async () => {
    const { updateAccountAutoPing } = await import("@/lib/db/index.js");

    const conn1 = await db.createProviderConnection({
      provider: "factory",
      authType: "oauth",
      email: "conc1@factory.com",
    });
    const conn2 = await db.createProviderConnection({
      provider: "factory",
      authType: "oauth",
      email: "conc2@factory.com",
    });

    // Run parallel saves simulating concurrent client actions
    const p1 = updateAccountAutoPing({
      provider: "factory",
      connectionId: conn1.id,
      reactive: true,
      schedule: {
        enabled: true,
        anchor: "09:30",
        timezone: "America/New_York",
        windowHours: 5,
        slotsPerDay: 3,
      },
    });

    const p2 = updateAccountAutoPing({
      provider: "factory",
      connectionId: conn2.id,
      reactive: false,
      schedule: {
        enabled: true,
        anchor: "14:00",
        timezone: "Europe/London",
        windowHours: 5,
        slotsPerDay: 2,
      },
    });

    await Promise.all([p1, p2]);

    const saved = await db.getSettings();
    expect(saved.factoryAutoPing.connections[conn1.id]).toBe(true);
    expect(saved.factoryAutoPing.schedules[conn1.id].anchor).toBe("09:30");
    expect(saved.factoryAutoPing.schedules[conn1.id].timezone).toBe("America/New_York");

    expect(saved.factoryAutoPing.connections[conn2.id]).toBe(false);
    expect(saved.factoryAutoPing.schedules[conn2.id].anchor).toBe("14:00");
    expect(saved.factoryAutoPing.schedules[conn2.id].timezone).toBe("Europe/London");
  });

  it("invalid provider/connection mismatch rejected without writes", async () => {
    const { updateAccountAutoPing } = await import("@/lib/db/index.js");

    const factoryOAuth = await db.createProviderConnection({
      provider: "factory",
      authType: "oauth",
      email: "oauth@factory.com",
    });
    const codexOAuth = await db.createProviderConnection({
      provider: "codex",
      authType: "oauth",
      email: "oauth@codex.com",
    });
    const factoryApiKey = await db.createProviderConnection({
      provider: "factory",
      authType: "apikey",
      name: "Factory Key",
    });

    await db.updateSettings({
      factoryAutoPing: {
        sentinel: "untouched",
        connections: { [factoryOAuth.id]: true },
      },
    });

    // 1. Unknown provider rejected
    await expect(
      updateAccountAutoPing({
        provider: "unknown-provider",
        connectionId: factoryOAuth.id,
        reactive: true,
        schedule: null,
      })
    ).rejects.toThrow();

    // 2. Inherited provider names rejected (Object.hasOwn enforcement)
    await expect(
      updateAccountAutoPing({
        provider: "toString",
        connectionId: factoryOAuth.id,
        reactive: true,
        schedule: null,
      })
    ).rejects.toThrow();

    await expect(
      updateAccountAutoPing({
        provider: "constructor",
        connectionId: factoryOAuth.id,
        reactive: true,
        schedule: null,
      })
    ).rejects.toThrow();

    // 3. Non-existent connection rejected
    await expect(
      updateAccountAutoPing({
        provider: "factory",
        connectionId: "missing-conn-uuid",
        reactive: true,
        schedule: null,
      })
    ).rejects.toThrow();

    // 4. Provider mismatch rejected (connection belongs to codex, requested factory)
    await expect(
      updateAccountAutoPing({
        provider: "factory",
        connectionId: codexOAuth.id,
        reactive: true,
        schedule: null,
      })
    ).rejects.toThrow();

    // 5. Non-OAuth connection rejected (authType is apikey)
    await expect(
      updateAccountAutoPing({
        provider: "factory",
        connectionId: factoryApiKey.id,
        reactive: true,
        schedule: null,
      })
    ).rejects.toThrow();

    // Verify settings were not modified by any of the failed attempts
    const saved = await db.getSettings();
    expect(saved.factoryAutoPing.sentinel).toBe("untouched");
    expect(saved.factoryAutoPing.connections[factoryOAuth.id]).toBe(true);
  });

  describe("PATCH /api/settings/auto-ping route endpoint", () => {
    it("rejects prototype pollution and mass-assignment keys with 400", async () => {
      const { PATCH } = await import("@/app/api/settings/auto-ping/route.js");

      const conn = await db.createProviderConnection({
        provider: "factory",
        authType: "oauth",
        email: "route-guard@factory.com",
      });

      await db.updateSettings({
        factoryAutoPing: {
          sentinel: "unmodified",
          connections: { [conn.id]: false },
        },
      });

      // Prototype pollution attempt with valid seeded connection
      const rawPayload = JSON.stringify({
        provider: "factory",
        connectionId: conn.id,
        reactive: true,
        schedule: null,
      }).replace(/\}$/, ',"__proto__":{"polluted":true}}');

      const req1 = new Request("http://localhost/api/settings/auto-ping", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: rawPayload,
      });
      const res1 = await PATCH(req1);
      expect(res1.status).toBe(400);
      expect(Object.prototype.polluted).toBeUndefined();

      // Mass-assignment of extra keys attempt with valid seeded connection
      const req2 = new Request("http://localhost/api/settings/auto-ping", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "factory",
          connectionId: conn.id,
          reactive: true,
          schedule: null,
          password: "new-password",
          requireLogin: false,
        }),
      });
      const res2 = await PATCH(req2);
      expect(res2.status).toBe(400);

      // Verify DB settings unchanged
      const saved = await db.getSettings();
      expect(saved.factoryAutoPing.sentinel).toBe("unmodified");
      expect(saved.factoryAutoPing.connections[conn.id]).toBe(false);
      expect(saved.requireLogin).not.toBe(false);
    });

    it("rejects invalid types, inherited provider names, and malformed schedules with 400", async () => {
      const { PATCH } = await import("@/app/api/settings/auto-ping/route.js");

      const conn = await db.createProviderConnection({
        provider: "factory",
        authType: "oauth",
        email: "types-guard@factory.com",
      });

      await db.updateSettings({
        factoryAutoPing: {
          sentinel: "safe",
          connections: { [conn.id]: false },
        },
      });

      // Malformed JSON body
      const resMalformed = await PATCH(new Request("http://localhost/api/settings/auto-ping", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: "{not-json",
      }));
      expect(resMalformed.status).toBe(400);

      // Non-boolean reactive
      const req1 = new Request("http://localhost/api/settings/auto-ping", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "factory",
          connectionId: conn.id,
          reactive: "not-a-bool",
          schedule: null,
        }),
      });
      const res1 = await PATCH(req1);
      expect(res1.status).toBe(400);

      // Non-object schedule string
      const req2 = new Request("http://localhost/api/settings/auto-ping", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "factory",
          connectionId: conn.id,
          reactive: true,
          schedule: "invalid-schedule-string",
        }),
      });
      const res2 = await PATCH(req2);
      expect(res2.status).toBe(400);

      // Inherited provider name
      const req3 = new Request("http://localhost/api/settings/auto-ping", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "toString",
          connectionId: conn.id,
          reactive: true,
          schedule: null,
        }),
      });
      const res3 = await PATCH(req3);
      expect(res3.status).toBe(400);

      // Verify DB settings unchanged
      const saved = await db.getSettings();
      expect(saved.factoryAutoPing.sentinel).toBe("safe");
      expect(saved.factoryAutoPing.connections[conn.id]).toBe(false);
    });

    it("saves account delta, returns only provider config without secrets, and updates state", async () => {
      const { PATCH } = await import("@/app/api/settings/auto-ping/route.js");

      const conn = await db.createProviderConnection({
        provider: "factory",
        authType: "oauth",
        email: "route-test@factory.com",
      });

      await db.updateSettings({
        password: "super-secret-hash",
        requireLogin: true,
        oidcClientSecret: "oidc-secret-value",
        factoryAutoPing: {
          enabled: true,
          customLabel: "my-label",
        },
      });

      const req = new Request("http://localhost/api/settings/auto-ping", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "factory",
          connectionId: conn.id,
          reactive: true,
          schedule: {
            enabled: true,
            anchor: "09:30",
            timezone: "America/New_York",
            windowHours: 5,
            slotsPerDay: 3,
          },
        }),
      });

      const res = await PATCH(req);
      expect(res.status).toBe(200);

      const json = await res.json();
      // Returns provider config delta
      expect(json.connections[conn.id]).toBe(true);
      expect(json.schedules[conn.id].anchor).toBe("09:30");
      expect(json.customLabel).toBe("my-label");

      // MUST NOT contain global settings or secrets
      expect(json.password).toBeUndefined();
      expect(json.requireLogin).toBeUndefined();
      expect(json.oidcClientSecret).toBeUndefined();
      expect(json.cloudEnabled).toBeUndefined();

      // Verify persisted in DB
      const saved = await db.getSettings();
      expect(saved.factoryAutoPing.connections[conn.id]).toBe(true);
      expect(saved.factoryAutoPing.schedules[conn.id].anchor).toBe("09:30");
    });

    it("rejects route request on connection/provider/authType mismatch with 400/404 without writes", async () => {
      const { PATCH } = await import("@/app/api/settings/auto-ping/route.js");

      const factoryOAuth = await db.createProviderConnection({
        provider: "factory",
        authType: "oauth",
        email: "route-oauth@factory.com",
      });
      const codexOAuth = await db.createProviderConnection({
        provider: "codex",
        authType: "oauth",
        email: "route-codex@codex.com",
      });
      const factoryApiKey = await db.createProviderConnection({
        provider: "factory",
        authType: "apikey",
        name: "Route Api Key",
      });

      await db.updateSettings({
        factoryAutoPing: {
          sentinel: "route-safe",
          connections: { [factoryOAuth.id]: false },
        },
      });

      // 1. Unknown provider -> 400
      const res1 = await PATCH(new Request("http://localhost/api/settings/auto-ping", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "openai",
          connectionId: factoryOAuth.id,
          reactive: true,
          schedule: null,
        }),
      }));
      expect(res1.status).toBe(400);

      // 2. Missing connection -> 404
      const res2 = await PATCH(new Request("http://localhost/api/settings/auto-ping", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "factory",
          connectionId: "missing-conn-uuid",
          reactive: true,
          schedule: null,
        }),
      }));
      expect(res2.status).toBe(404);

      // 3. Provider mismatch -> 400
      const res3 = await PATCH(new Request("http://localhost/api/settings/auto-ping", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "factory",
          connectionId: codexOAuth.id,
          reactive: true,
          schedule: null,
        }),
      }));
      expect(res3.status).toBe(400);

      // 4. Non-OAuth connection -> 400
      const res4 = await PATCH(new Request("http://localhost/api/settings/auto-ping", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "factory",
          connectionId: factoryApiKey.id,
          reactive: true,
          schedule: null,
        }),
      }));
      expect(res4.status).toBe(400);

      // Assert database unchanged
      const saved = await db.getSettings();
      expect(saved.factoryAutoPing.sentinel).toBe("route-safe");
      expect(saved.factoryAutoPing.connections[factoryOAuth.id]).toBe(false);
    });

    it("returns 500 on unexpected database failure", async () => {
      const { PATCH } = await import("@/app/api/settings/auto-ping/route.js");
      const { getAdapter } = await import("@/lib/db/driver.js");

      const conn = await db.createProviderConnection({
        provider: "factory",
        authType: "oauth",
        email: "db-fail@factory.com",
      });

      const adapter = await getAdapter();
      const origTransaction = adapter.transaction;
      adapter.transaction = () => {
        throw new Error("Disk I/O error or table corrupted");
      };

      try {
        const res = await PATCH(new Request("http://localhost/api/settings/auto-ping", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: "factory",
            connectionId: conn.id,
            reactive: true,
            schedule: null,
          }),
        }));
        expect(res.status).toBe(500);
        const data = await res.json();
        expect(data.error).toBe("Internal server error");
      } finally {
        adapter.transaction = origTransaction;
      }
    });
  });

  describe("PATCH /api/settings clean cutover", () => {
    it("rejects whole auto-ping configurations with 400 and preserves unrelated settings", async () => {
      const { PATCH: patchSettings } = await import("@/app/api/settings/route.js");

      // 1. Rejects claudeAutoPing
      const resClaude = await patchSettings(new Request("http://localhost/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claudeAutoPing: { enabled: true } }),
      }));
      expect(resClaude.status).toBe(400);

      // 2. Rejects codexAutoPing
      const resCodex = await patchSettings(new Request("http://localhost/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codexAutoPing: { enabled: true } }),
      }));
      expect(resCodex.status).toBe(400);

      // 3. Rejects factoryAutoPing directing to delta endpoint
      const resFactory = await patchSettings(new Request("http://localhost/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ factoryAutoPing: { enabled: true } }),
      }));
      expect(resFactory.status).toBe(400);
      const dataFactory = await resFactory.json();
      expect(dataFactory.error).toContain("/api/settings/auto-ping");

      // 4. Unrelated settings succeed
      const resUnrelated = await patchSettings(new Request("http://localhost/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rtkEnabled: false }),
      }));
      expect(resUnrelated.status).toBe(200);
      const saved = await db.getSettings();
      expect(saved.rtkEnabled).toBe(false);
    });
  });
});
