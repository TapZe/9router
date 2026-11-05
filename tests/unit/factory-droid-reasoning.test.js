import { describe, expect, it } from "vitest";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import factoryRegistry from "../../open-sse/providers/registry/factory.js";
import { FactoryExecutor, factoryEffortFor } from "../../open-sse/executors/factory.js";

// Efforts and the default effort Droid 1.3.0 lists for each model, read from
// the binary's model registry. "none" is Droid's off effort.
const DROID_1_3_0_EFFORTS = {
  "aster-07-15": [["none", "low", "medium", "high", "xhigh", "max"], "high"],
  "atlas-07-21": [["none", "low", "medium", "high", "xhigh", "max"], "high"],
  "beam-1.0": [["low", "medium", "high", "xhigh", "max"], "high"],
  "claude-fable-5": [["none", "low", "medium", "high", "xhigh", "max"], "high"],
  "claude-fable-5.1": [["none", "low", "medium", "high", "xhigh", "max"], "high"],
  "claude-haiku-4-5-20251001": [["none", "low", "medium", "high"], "none"],
  "claude-haiku-5-5": [["none", "low", "medium", "high", "xhigh", "max"], "medium"],
  "claude-opus-4-5-20251101": [["none", "low", "medium", "high"], "none"],
  "claude-opus-4-6": [["none", "low", "medium", "high", "max"], "high"],
  "claude-opus-4-6-fast": [["none", "low", "medium", "high", "max"], "high"],
  "claude-opus-4-7": [["none", "low", "medium", "high", "xhigh", "max"], "high"],
  "claude-opus-4-7-fast": [["none", "low", "medium", "high", "xhigh", "max"], "high"],
  "claude-opus-4-8": [["none", "low", "medium", "high", "xhigh", "max"], "high"],
  "claude-opus-4-8-fast": [["none", "low", "medium", "high", "xhigh", "max"], "high"],
  "claude-opus-5": [["none", "low", "medium", "high", "xhigh", "max"], "high"],
  "claude-opus-5-5": [["low", "medium", "high", "xhigh", "max"], "medium"],
  "claude-opus-5-5-fast": [["low", "medium", "high", "xhigh", "max"], "medium"],
  "claude-opus-5-fast": [["none", "low", "medium", "high", "xhigh", "max"], "high"],
  "claude-sonnet-4-5-20250929": [["none", "low", "medium", "high"], "none"],
  "claude-sonnet-4-6": [["none", "low", "medium", "high", "max"], "high"],
  "claude-sonnet-5": [["none", "low", "medium", "high", "xhigh", "max"], "high"],
  "claude-sonnet-5-5": [["none", "low", "medium", "high", "xhigh", "max"], "high"],
  "deepseek-v4-flash-0731": [["none", "low", "high", "max"], "high"],
  "deepseek-v4-pro": [["none", "low", "high", "max"], "high"],
  "deepseek-v4.1-flash": [["none", "low", "high", "max"], "high"],
  "deepseek-v4.1-flash-1017": [["none", "low", "high", "max"], "high"],
  "garnet-07-15": [["medium", "high"], "high"],
  "gemini-3-flash-preview": [["minimal", "low", "medium", "high"], "high"],
  "gemini-3-pro-preview": [["none", "low", "medium", "high"], "high"],
  "gemini-3.1-pro-preview": [["low", "medium", "high"], "high"],
  "gemini-3.5-flash": [["minimal", "low", "medium", "high"], "high"],
  "gemini-3.6-flash": [["low", "medium", "high"], "high"],
  "gemini-3.7-flash": [["low", "medium", "high"], "high"],
  "gemini-3.8-flash": [["low", "medium", "high"], "high"],
  "gemini-4-argon": [["low", "medium", "high"], "medium"],
  "glm-4.6": [["none"], "none"],
  "glm-4.7": [["none"], "none"],
  "glm-5": [["none"], "none"],
  "glm-5.1": [["none", "high"], "high"],
  "glm-5.2": [["none", "high", "max"], "high"],
  "glm-5.2-fast": [["none", "high", "max"], "high"],
  "glm-5.3": [["low", "high", "max"], "max"],
  "glm-5.3-flash": [["low", "high", "max"], "high"],
  "gpt-5.1-codex-max": [["low", "medium", "high", "xhigh"], "medium"],
  "gpt-5.2": [["none", "low", "medium", "high", "xhigh"], "low"],
  "gpt-5.2-codex": [["low", "medium", "high", "xhigh"], "medium"],
  "gpt-5.3-codex": [["low", "medium", "high", "xhigh"], "medium"],
  "gpt-5.3-codex-fast": [["low", "medium", "high", "xhigh"], "medium"],
  "gpt-5.4": [["low", "medium", "high", "xhigh"], "medium"],
  "gpt-5.4-fast": [["low", "medium", "high", "xhigh"], "medium"],
  "gpt-5.4-mini": [["low", "medium", "high", "xhigh"], "high"],
  "gpt-5.4-mini-fast": [["low", "medium", "high", "xhigh"], "high"],
  "gpt-5.5": [["low", "medium", "high", "xhigh"], "medium"],
  "gpt-5.5-fast": [["low", "medium", "high", "xhigh"], "medium"],
  "gpt-5.5-pro": [["medium", "high", "xhigh"], "medium"],
  "gpt-5.6-luna": [["none", "low", "medium", "high", "xhigh", "max"], "medium"],
  "gpt-5.6-sol": [["none", "low", "medium", "high", "xhigh", "max"], "medium"],
  "gpt-5.6-sol-fast": [["none", "low", "medium", "high", "xhigh", "max"], "medium"],
  "gpt-5.6-terra": [["none", "low", "medium", "high", "xhigh", "max"], "medium"],
  "gpt-6-astra": [["low", "medium", "high", "xhigh", "max"], "medium"],
  "gpt-6-luna": [["none", "low", "medium", "high", "xhigh", "max"], "medium"],
  "gpt-6-luna-fast": [["none", "low", "medium", "high", "xhigh", "max"], "medium"],
  "gpt-6-sol": [["none", "low", "medium", "high", "xhigh", "max"], "medium"],
  "gpt-6-sol-fast": [["none", "low", "medium", "high", "xhigh", "max"], "medium"],
  "gpt-6.1-sol": [["low", "medium", "high", "xhigh", "max"], "medium"],
  "gpt-6.1-sol-ultrafast": [["low", "medium", "high", "xhigh", "max"], "medium"],
  "gpt-6.1-terra": [["none", "low", "medium", "high", "xhigh", "max"], "medium"],
  "grok-4.5": [["low", "medium", "high"], "high"],
  "grok-4.6": [["low", "medium", "high", "xhigh"], "high"],
  "grok-4.7": [["low", "medium", "high", "xhigh"], "high"],
  "inkling": [["none", "minimal", "low", "medium", "high", "xhigh", "max"], "high"],
  "kimi-k2.5": [["none", "high"], "high"],
  "kimi-k2.6": [["none", "high"], "high"],
  "kimi-k2.7-code": [["none", "high"], "high"],
  "kimi-k3": [["none", "low", "high", "max"], "high"],
  "minimax-m2.5": [["low", "medium", "high"], "high"],
  "minimax-m2.7": [["high"], "high"],
  "minimax-m3": [["high"], "high"],
  "minimax-m3.1-flash": [["low", "medium", "high", "xhigh", "max"], "max"],
  "mistral-large-4": [["none", "high"], "high"],
  "mistral-medium-3.5": [["none", "high"], "high"],
  "muse-spark-1.2": [["low", "medium", "high", "xhigh"], "high"],
  "muse-spark-1.3": [["low", "medium", "high", "xhigh"], "high"],
  "muse-spark-open": [["low", "medium", "high", "xhigh", "max"], "high"],
  "nemotron-3-ultra": [["none", "high"], "high"],
  "nemotron-3.5-super": [["none", "high"], "high"],
  "qwen3.8-max": [["low", "medium", "xhigh"], "xhigh"],
};

describe("Factory reasoning efforts from Droid 1.3.0", () => {
  const registered = factoryRegistry.models.map(({ id }) => id).filter((id) => DROID_1_3_0_EFFORTS[id]);

  it("offers each model the efforts Droid 1.3.0 lists", () => {
    for (const id of registered) {
      const [efforts] = DROID_1_3_0_EFFORTS[id];
      const reasons = efforts.some((effort) => effort !== "none");
      for (const provider of ["factory", "fy", "droid"]) {
        expect(getThinkingLevels(provider, id), `${provider}/${id}`).toEqual(reasons ? efforts : null);
      }
      expect(getCapabilitiesForModel("factory", id), id).toMatchObject({
        reasoning: reasons,
        thinkingCanDisable: !reasons || efforts.includes("none"),
      });
    }
  });

  it("sends a supported effort when the client asks for one the model lacks", () => {
    const executor = new FactoryExecutor();
    const effortFor = (model, effort) => {
      const body = executor.transformRequest(model, { messages: [], reasoning_effort: effort }, true, {});
      return body.reasoning?.effort ?? body.reasoning_effort ?? body.generationConfig?.thinkingConfig?.thinkingLevel;
    };
    // Effort-only models have no off, so none goes to their lowest effort.
    expect(effortFor("gpt-6.1-sol", "none")).toBe("low");
    expect(effortFor("gpt-5.5-pro", "none")).toBe("medium");
    // Garnet's medium effort goes upstream as Droid's HIGH thinking level.
    expect(factoryEffortFor("garnet-07-15", "low")).toBe("medium");
    expect(effortFor("garnet-07-15", "low")).toBe("HIGH");
    // A missing higher effort steps down to the nearest listed one.
    expect(effortFor("kimi-k2.6", "medium")).toBe("high");
    expect(effortFor("qwen3.8-max", "high")).toBe("medium");
    expect(effortFor("gpt-5.5", "max")).toBe("xhigh");
    expect(effortFor("gpt-5.6-sol", "max")).toBe("max");
    expect(effortFor("glm-5.3", "medium")).toBe("low");
    // A listed effort goes through as it is.
    expect(effortFor("inkling", "minimal")).toBe("minimal");
    expect(effortFor("gpt-5.2", "none")).toBe("none");
  });

  it("uses the Droid default effort when a Claude request names none", () => {
    const executor = new FactoryExecutor();
    const body = executor.transformRequest("claude-sonnet-4-5-20250929", { messages: [], max_tokens: 64000 }, true, {});
    expect(DROID_1_3_0_EFFORTS["claude-sonnet-4-5-20250929"][1]).toBe("none");
    expect(body.thinking).toBeUndefined();
    const opus = executor.transformRequest("claude-opus-4-8", { messages: [], max_tokens: 64000 }, true, {});
    expect(opus.output_config).toEqual({ effort: DROID_1_3_0_EFFORTS["claude-opus-4-8"][1] });
  });
});
