import { describe, expect, it } from "vitest";
import { getPricingForModel } from "../../open-sse/providers/pricing.js";

// Droid 1.10.0 ships a rate card per provider, per million tokens in its
// credit unit (rates.input equals cost.tokenMultiplier). One unit is 2.5 USD:
// Sonnet 4.6's 1.2/6 is Anthropic's $3/$15. Factory requests use the card of
// the provider Droid routes to in the global region.
const price = (model) => getPricingForModel("factory", model);

describe("Factory pricing from Droid 1.10.0 rate cards", () => {
  it("prices Anthropic models from Droid's anthropic card, with the 5-minute cache write", () => {
    expect(price("claude-fable-5.2")).toEqual({ input: 8, output: 40, cached: 0.2, reasoning: 40, cache_creation: 10 });
    expect(price("claude-fable-5.1")).toEqual({ input: 10, output: 50, cached: 0.25, reasoning: 50, cache_creation: 12.5 });
    expect(price("claude-opus-5-5-fast")).toEqual({ input: 8, output: 40, cached: 0.4, reasoning: 40, cache_creation: 10 });
    expect(price("claude-sonnet-4-6")).toEqual({ input: 3, output: 15, cached: 0.3, reasoning: 15, cache_creation: 3.75 });
  });

  it("prices other providers' models without a cache write rate", () => {
    expect(price("gpt-5.3-codex")).toEqual({ input: 1.75, output: 14, cached: 0.175, reasoning: 14 });
    expect(price("gemini-4-hydrogen")).toEqual({ input: 1.5, output: 7.5, cached: 0.075, reasoning: 7.5 });
    expect(price("gemini-4-carbon")).toEqual({ input: 4, output: 20, cached: 0.2, reasoning: 20 });
    expect(price("gemini-3.1-pro-preview")).toEqual({ input: 2, output: 12, cached: 0.2, reasoning: 12 });
    expect(price("kimi-k3")).toEqual({ input: 3, output: 15, cached: 0.3, reasoning: 15 });
    // muse-spark-open and nemotron-3-ultra go to baseten in the global region.
    expect(price("muse-spark-open")).toEqual({ input: 1.25, output: 4.25, cached: 0.15, reasoning: 4.25 });
    expect(price("nemotron-3-ultra")).toEqual({ input: 0.6, output: 2.4, cached: 0.12, reasoning: 2.4 });
  });

  it("keeps the existing price where Droid has no usable card", () => {
    // No card for the routed provider, or a card copied from another model.
    for (const model of ["gpt-5.5", "grok-4.7", "mistral-large-4", "deepseek-v4-pro", "deepseek-v4-flash-0731", "muse-spark-1.2", "gemini-4-argon"]) {
      expect(price(model), model).toEqual(getPricingForModel("some-other-provider", model));
    }
  });
});
