import { describe, expect, it } from "vitest";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

// Input tokens, output tokens, and image support Droid 1.3.0 lists for each
// model, read from the binary's model registry.
const DROID_1_3_0_LIMITS = {
  "aster-07-15": [867000, 128000, true],
  "atlas-07-21": [867000, 128000, true],
  "beam-1.0": [1015808, 32768, false],
  "claude-fable-5": [867000, 128000, true],
  "claude-fable-5.1": [867000, 128000, true],
  "claude-haiku-4-5-20251001": [180000, 32000, true],
  "claude-haiku-5-5": [872000, 128000, true],
  "claude-opus-4-5-20251101": [180000, 64000, true],
  "claude-opus-4-6": [867000, 128000, true],
  "claude-opus-4-6-fast": [867000, 128000, true],
  "claude-opus-4-7": [867000, 128000, true],
  "claude-opus-4-7-fast": [867000, 128000, true],
  "claude-opus-4-8": [867000, 128000, true],
  "claude-opus-4-8-fast": [867000, 128000, true],
  "claude-opus-5": [867000, 128000, true],
  "claude-opus-5-5": [872000, 128000, true],
  "claude-opus-5-5-fast": [872000, 128000, true],
  "claude-opus-5-fast": [867000, 128000, true],
  "claude-sonnet-4-5-20250929": [180000, 32000, true],
  "claude-sonnet-4-6": [931000, 64000, true],
  "claude-sonnet-5": [872000, 128000, true],
  "claude-sonnet-5-5": [872000, 128000, true],
  "deepseek-v4-flash-0731": [908928, 131072, false],
  "deepseek-v4-pro": [908928, 131072, false],
  "deepseek-v4.1-flash": [908928, 131072, true],
  "deepseek-v4.1-flash-1017": [908928, 131072, true],
  "garnet-07-15": [1000000, 65536, true],
  "gemini-3-flash-preview": [1000000, 65536, true],
  "gemini-3-pro-preview": [1000000, 65536, true],
  "gemini-3.1-pro-preview": [1000000, 65536, true],
  "gemini-3.5-flash": [1000000, 65536, true],
  "gemini-3.6-flash": [1000000, 65536, true],
  "gemini-3.7-flash": [1000000, 65536, true],
  "gemini-3.8-flash": [1000000, 65536, true],
  "gemini-4-argon": [934464, 65536, true],
  "glm-4.6": [200000, 128000, false],
  "glm-4.7": [198000, 25344, false],
  "glm-5": [190000, 32000, false],
  "glm-5.1": [134464, 65536, false],
  "glm-5.2": [908928, 131072, false],
  "glm-5.2-fast": [393216, 131072, false],
  "glm-5.3": [908928, 131072, false],
  "glm-5.3-flash": [917504, 131072, true],
  "gpt-5.1-codex-max": [367232, 32768, true],
  "gpt-5.2": [272000, 128000, true],
  "gpt-5.2-codex": [272000, 128000, true],
  "gpt-5.3-codex": [272000, 128000, true],
  "gpt-5.3-codex-fast": [272000, 128000, true],
  "gpt-5.4": [922000, 128000, true],
  "gpt-5.4-fast": [922000, 128000, true],
  "gpt-5.4-mini": [272000, 128000, true],
  "gpt-5.4-mini-fast": [272000, 128000, true],
  "gpt-5.5": [922000, 128000, true],
  "gpt-5.5-fast": [922000, 128000, true],
  "gpt-5.5-pro": [922000, 128000, true],
  "gpt-5.6-luna": [922000, 128000, true],
  "gpt-5.6-sol": [922000, 128000, true],
  "gpt-5.6-sol-fast": [922000, 128000, true],
  "gpt-5.6-terra": [922000, 128000, true],
  "gpt-6-astra": [922000, 128000, true],
  "gpt-6-luna": [922000, 128000, true],
  "gpt-6-luna-fast": [922000, 128000, true],
  "gpt-6-sol": [922000, 128000, true],
  "gpt-6-sol-fast": [922000, 128000, true],
  "gpt-6.1-sol": [922000, 128000, true],
  "gpt-6.1-sol-ultrafast": [922000, 128000, true],
  "gpt-6.1-terra": [922000, 128000, true],
  "grok-4.5": [200000, 63356, true],
  "grok-4.6": [200000, 63356, true],
  "grok-4.7": [436644, 63356, true],
  "inkling": [1007232, 32768, true],
  "kimi-k2.5": [256000, 32768, true],
  "kimi-k2.6": [196608, 65536, true],
  "kimi-k2.7-code": [196608, 65536, true],
  "kimi-k3": [196608, 65536, true],
  "minimax-m2.5": [204800, 64000, false],
  "minimax-m2.7": [196600, 64000, false],
  "minimax-m3": [448000, 64000, true],
  "minimax-m3.1-flash": [868928, 131072, true],
  "mistral-large-4": [524288, 64000, true],
  "mistral-medium-3.5": [192000, 64000, true],
  "muse-spark-1.2": [908928, 131072, false],
  "muse-spark-1.3": [908928, 131072, false],
  "muse-spark-open": [908928, 131072, true],
  "nemotron-3-ultra": [136464, 65536, false],
  "nemotron-3.5-super": [934464, 65536, true],
  "qwen3.8-max": [131072, 131072, false],
};

// Anthropic caps these models at 200k tokens, below Droid's input plus output budget.
const ANTHROPIC_200K = ["claude-opus-4-5-20251101", "claude-sonnet-4-5-20250929", "claude-haiku-4-5-20251001"];

describe("Factory limits and images from Droid 1.3.0", () => {
  it("gives each model Droid's context window, output limit, and image support", () => {
    for (const [id, [maxIn, maxOut, images]] of Object.entries(DROID_1_3_0_LIMITS)) {
      const contextWindow = ANTHROPIC_200K.includes(id) ? 200000 : maxIn + maxOut;
      for (const provider of ["factory", "fy", "droid"]) {
        expect(getCapabilitiesForModel(provider, id), `${provider}/${id}`).toMatchObject({ contextWindow, maxOutput: maxOut, vision: images });
      }
    }
  });
});
