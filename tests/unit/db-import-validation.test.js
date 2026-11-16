import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { setupGeminiWebDb } from "../helpers/geminiWebDb.js";

const fixture = await setupGeminiWebDb();
const database = await import("../../src/lib/db/index.js");

const SETTINGS_MARKER = {
  cloudUrl: "http://127.0.0.1:9/synthetic-cloud",
  outboundProxyEnabled: false,
  stickyRoundRobinLimit: 7,
};

const UNRELATED_PROVIDERS = new Set(["openai", "anthropic"]);

async function seedUnrelated() {
  const openai = await database.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "synthetic-openai",
    apiKey: "sk-synthetic-openai",
    isActive: true,
  });
  const anthropic = await database.createProviderConnection({
    provider: "anthropic",
    authType: "apikey",
    name: "synthetic-anthropic",
    apiKey: "sk-synthetic-anthropic",
    isActive: true,
  });
  await database.updateSettings(SETTINGS_MARKER);
  return { openaiId: openai.id, anthropicId: anthropic.id };
}

async function unrelatedSnapshot() {
  const rows = await database.getProviderConnections();
  const settings = await database.getSettings();
  return {
    connections: rows
      .filter((row) => UNRELATED_PROVIDERS.has(row.provider))
      .map((row) => ({
        id: row.id,
        provider: row.provider,
        authType: row.authType,
        name: row.name,
        apiKey: row.apiKey,
        isActive: row.isActive,
      }))
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
    settings: {
      cloudUrl: settings.cloudUrl,
      outboundProxyEnabled: settings.outboundProxyEnabled,
      stickyRoundRobinLimit: settings.stickyRoundRobinLimit,
    },
  };
}

beforeEach(() => {
  fixture.clear();
});

afterAll(() => {
  fixture.teardown();
});

describe("database import validation", () => {
  it("rejects malformed collections before replacing seeded connections or settings", async () => {
    await seedUnrelated();
    const before = await unrelatedSnapshot();

    const malformed = [
      { providerConnections: {} },
      { providerConnections: "connections" },
      { providerConnections: 42 },
      { providerConnections: true },
      { providerConnections: [null] },
      { providerConnections: [], providerNodes: {} },
      { providerConnections: [], proxyPools: "pools" },
      { providerConnections: [], apiKeys: {} },
      { providerConnections: [], combos: 7 },
      { providerConnections: [], customModels: {} },
      { providerConnections: [], modelAliases: [] },
      { providerConnections: [], mitmAlias: "aliases" },
      { providerConnections: [], pricing: [] },
      { providerConnections: [], geminiWebSessions: {} },
    ];

    for (const payload of malformed) {
      const field =
        Object.keys(payload).find((key) => key !== "providerConnections") ||
        "providerConnections";
      await expect(database.importDb(payload)).rejects.toThrow(new RegExp(field));
      expect(await unrelatedSnapshot()).toEqual(before);
    }
  });

  it("restores explicit null collections as the legacy empty shape the importer always normalized", async () => {
    await seedUnrelated();
    expect((await database.getProviderConnections()).length).toBe(2);

    const result = await database.importDb({
      settings: null,
      providerConnections: null,
      providerNodes: null,
      proxyPools: null,
      apiKeys: null,
      combos: null,
      modelAliases: null,
      customModels: null,
      mitmAlias: null,
      pricing: null,
      geminiWebSessions: null,
    });

    expect(result.providerConnections).toEqual([]);
    expect(result.providerNodes).toEqual([]);
    expect(result.proxyPools).toEqual([]);
    expect(result.apiKeys).toEqual([]);
    expect(result.combos).toEqual([]);
    expect(result.customModels).toEqual([]);
    expect(result.geminiWebSessions).toEqual([]);
    expect(result.modelAliases).toEqual({});
    expect(result.mitmAlias).toEqual({});
    expect(await database.getProviderConnections()).toEqual([]);
  });

  it("still restores a valid backup and the legacy shape without optional collections", async () => {
    const seeded = await seedUnrelated();
    const snapshot = await database.exportDb();

    await database.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: "synthetic-openai-extra",
      apiKey: "sk-synthetic-extra",
    });
    await database.updateSettings({ cloudUrl: "http://127.0.0.1:9/changed" });
    expect((await database.getProviderConnections()).length).toBe(3);

    await database.importDb(snapshot);
    const restoredRows = await database.getProviderConnections();
    expect(restoredRows.length).toBe(2);
    expect(await database.getProviderConnectionById(seeded.openaiId)).toMatchObject({
      provider: "openai",
      name: "synthetic-openai",
      apiKey: "sk-synthetic-openai",
    });
    expect(await database.getProviderConnectionById(seeded.anthropicId)).toMatchObject({
      provider: "anthropic",
      apiKey: "sk-synthetic-anthropic",
    });
    expect((await database.getSettings()).cloudUrl).toBe(SETTINGS_MARKER.cloudUrl);

    await database.importDb({ providerConnections: [] });
    expect(await database.getProviderConnections()).toEqual([]);
  });
});
