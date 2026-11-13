// Factory requests are priced at OpenRouter's listed price for the same
// upstream model (openrouter.ai/api/v1/models, 2026-11-13). Droid's own rate
// cards are in Factory credits, so they are not used.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { getPricingForModel } from "../../open-sse/providers/pricing.js";

describe("Factory prices from OpenRouter", () => {
  it("prices the Droid 1.10.0 models at OpenRouter's listed price", () => {
    expect(getPricingForModel("factory", "claude-fable-5.2")).toEqual({ input: 8, output: 40, cached: 0.2, reasoning: 40, cache_creation: 10 });
    expect(getPricingForModel("factory", "gemini-4-hydrogen")).toEqual({ input: 1.5, output: 7.5, cached: 0.075, reasoning: 7.5, cache_creation: 0.083333 });
    expect(getPricingForModel("factory", "gemini-4-carbon")).toEqual({ input: 2, output: 10, cached: 0.1, reasoning: 10, cache_creation: 0.1875 });
  });

  it("maps Factory ids that OpenRouter spells differently", () => {
    expect(getPricingForModel("factory", "claude-opus-5-5")).toEqual({ input: 4, output: 20, cached: 0.2, reasoning: 20, cache_creation: 5 });
    expect(getPricingForModel("factory", "nemotron-3-ultra")).toMatchObject({ input: 0.6, output: 2.4, cached: 0.12 });
    expect(getPricingForModel("factory", "mistral-medium-3.5")).toMatchObject({ input: 1.5, output: 7.5 });
  });

  it("prices Muse Spark, including the open model", () => {
    for (const id of ["muse-spark-1.2", "muse-spark-1.3", "muse-spark-open"]) {
      expect(getPricingForModel("factory", id)).toEqual({ input: 1.25, output: 4.25, cached: 0.15, reasoning: 4.25 });
    }
  });

  it("leaves models with no OpenRouter equivalent on the general fallback", () => {
    expect(getPricingForModel("factory", "garnet-07-15")).toBeNull();
    expect(getPricingForModel("factory", "gpt-6-sol-fast")).toBeNull();
  });
});

describe("Factory price overrides", () => {
  const originalDataDir = process.env.DATA_DIR;
  let tempDir;
  let db;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-factory-pricing-"));
    process.env.DATA_DIR = tempDir;
    vi.resetModules();
    db = await import("@/lib/db/index.js");
    await db.initDb();
  });

  afterAll(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("a user's price still wins over the OpenRouter price", async () => {
    expect(await db.getPricingForModel("factory", "claude-fable-5.2")).toMatchObject({ input: 8, output: 40 });
    await db.updatePricing({ factory: { "claude-fable-5.2": { input: 1, output: 2 } } });
    expect(await db.getPricingForModel("factory", "claude-fable-5.2")).toEqual({ input: 1, output: 2 });
  });
});
