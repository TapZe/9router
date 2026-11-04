import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { swapConnectionOrder, swappedPriorityWrites } from "@/shared/utils/swapConnectionOrder.js";

const originalDataDir = process.env.DATA_DIR;

describe("connection priority adjacent swap", () => {
  let tempDir;
  let db;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-priority-swap-"));
    process.env.DATA_DIR = tempDir;
    delete global._dbAdapter;
    vi.resetModules();
    db = await import("@/lib/db/index.js");
    await db.initDb();
  });

  afterEach(() => {
    try { global._dbAdapter?.instance?.close?.(); } catch {}
    delete global._dbAdapter;
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  async function seed() {
    const a = await db.createProviderConnection({
      provider: "test", authType: "apikey", name: "a", apiKey: "k1",
    });
    const b = await db.createProviderConnection({
      provider: "test", authType: "apikey", name: "b", apiKey: "k2",
    });
    const c = await db.createProviderConnection({
      provider: "test", authType: "apikey", name: "c", apiKey: "k3",
    });
    return [a, b, c];
  }

  async function persistSwap(list, index1, index2) {
    const next = swapConnectionOrder(list, index1, index2);
    const result = await db.setProviderConnectionPriorities(
      swappedPriorityWrites(next),
    );
    expect(result.ok).toBe(true);
  }

  async function seedTied() {
    const a = await db.createProviderConnection({
      provider: "test", authType: "apikey", name: "a", apiKey: "k1", priority: 1,
    });
    const b = await db.createProviderConnection({
      provider: "test", authType: "apikey", name: "b", apiKey: "k2", priority: 1,
    });
    const c = await db.createProviderConnection({
      provider: "test", authType: "apikey", name: "c", apiKey: "k3", priority: 1,
    });
    return [a, b, c];
  }

  it("persists moving the third row up one slot", async () => {
    const list = await seed();
    await persistSwap(list, 2, 1);
    const stored = await db.getProviderConnections({ provider: "test" });
    expect(stored.map((row) => row.name)).toEqual(["a", "c", "b"]);
    expect(stored.map((row) => row.priority)).toEqual([1, 2, 3]);
  });

  it("persists moving the second row to the top", async () => {
    const list = await seed();
    await persistSwap(list, 1, 0);
    const stored = await db.getProviderConnections({ provider: "test" });
    expect(stored.map((row) => row.name)).toEqual(["b", "a", "c"]);
    expect(stored.map((row) => row.priority)).toEqual([1, 2, 3]);
  });

  it("persists a third-row up when every account is rank 1", async () => {
    const list = await seedTied();
    await persistSwap(list, 2, 1);
    const stored = await db.getProviderConnections({ provider: "test" });
    expect(stored.map((row) => row.name)).toEqual(["a", "c", "b"]);
    expect(stored.map((row) => row.priority)).toEqual([1, 2, 3]);
  });

  it("persists a second-row up when every account is rank 1", async () => {
    const list = await seedTied();
    await persistSwap(list, 1, 0);
    const stored = await db.getProviderConnections({ provider: "test" });
    expect(stored.map((row) => row.name)).toEqual(["b", "a", "c"]);
    expect(stored.map((row) => row.priority)).toEqual([1, 2, 3]);
  });


});

