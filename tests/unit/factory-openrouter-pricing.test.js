// Factory uses listed OpenRouter rates except for models with better maker
// prices or selected provisional rates from the Droid registry.
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

describe("Factory's provisional Droid rates", () => {
  it("uses the same estimates for Factory and its aliases", () => {
    for (const provider of ["factory", "fy", "droid", "factory-ai"]) {
      expect(getPricingForModel(provider, "gemini-4-neon")).toEqual({ input: 1.2, output: 6, cached: 0.06, reasoning: 6, cache_creation: 0 });
      expect(getPricingForModel(provider, "gpt-6.2-sol-ultrafast")).toEqual({ input: 2.4, output: 12, cached: 0.12, reasoning: 12, cache_creation: 3 });
    }
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

// OpenRouter's listings for these four are far off their makers' prices
// (e.g. kimi-k3 at $0.192 in / $16 out), so they use the maker's published API
// price in USD, read 2026-11-13.
describe("Factory prices from the model maker", () => {
  it("prices Kimi K3 at Moonshot's price", () => {
    expect(getPricingForModel("factory", "kimi-k3")).toEqual({ input: 3, output: 15, cached: 0.3, reasoning: 15, cache_creation: 3 });
  });

  it("prices GLM 5.2 and 5.3 at Z.ai's price", () => {
    for (const id of ["glm-5.2", "glm-5.3"]) {
      expect(getPricingForModel("factory", id)).toEqual({ input: 1.4, output: 4.4, cached: 0.26, reasoning: 4.4 });
    }
  });

  it("prices DeepSeek V4 Pro at DeepSeek's peak price", () => {
    expect(getPricingForModel("factory", "deepseek-v4-pro")).toEqual({ input: 1.32, output: 3.96, cached: 0.044, reasoning: 3.96 });
  });
});
