import { describe, expect, it } from "vitest";
import { upstreamProviderFor } from "../../open-sse/executors/factory.js";

// The provider Droid 1.3.0 picks for each model in the global region, read
// from the binary's model registry.
const DROID_1_3_0_GLOBAL_PROVIDERS = {
  "aster-07-15": "anthropic",
  "atlas-07-21": "anthropic",
  "beam-1.0": "baseten",
  "claude-fable-5": "anthropic",
  "claude-fable-5.1": "anthropic",
  "claude-haiku-4-5-20251001": "anthropic",
  "claude-haiku-5-5": "anthropic",
  "claude-opus-4-5-20251101": "anthropic",
  "claude-opus-4-6": "anthropic",
  "claude-opus-4-6-fast": "anthropic",
  "claude-opus-4-7": "anthropic",
  "claude-opus-4-7-fast": "anthropic",
  "claude-opus-4-8": "anthropic",
  "claude-opus-4-8-fast": "anthropic",
  "claude-opus-5": "anthropic",
  "claude-opus-5-5": "anthropic",
  "claude-opus-5-5-fast": "anthropic",
  "claude-opus-5-fast": "anthropic",
  "claude-sonnet-4-5-20250929": "anthropic",
  "claude-sonnet-4-6": "anthropic",
  "claude-sonnet-5": "anthropic",
  "claude-sonnet-5-5": "anthropic",
  "deepseek-v4-flash-0731": "fireworks",
  "deepseek-v4-pro": "fireworks",
  "deepseek-v4.1-flash": "fireworks",
  "deepseek-v4.1-flash-1017": "fireworks",
  "garnet-07-15": "google",
  "gemini-3-flash-preview": "google",
  "gemini-3-pro-preview": "google",
  "gemini-3.1-pro-preview": "google",
  "gemini-3.5-flash": "google",
  "gemini-3.6-flash": "google",
  "gemini-3.7-flash": "google",
  "gemini-3.8-flash": "google",
  "gemini-4-argon": "google",
  "glm-4.6": "baseten",
  "glm-4.7": "fireworks",
  "glm-5": "fireworks",
  "glm-5.1": "fireworks",
  "glm-5.2": "baseten",
  "glm-5.2-fast": "baseten",
  "glm-5.3": "fireworks",
  "glm-5.3-flash": "fireworks",
  "gpt-5.1-codex-max": "openai",
  "gpt-5.2": "openai",
  "gpt-5.2-codex": "openai",
  "gpt-5.3-codex": "openai",
  "gpt-5.3-codex-fast": "openai",
  "gpt-5.4": "openai",
  "gpt-5.4-fast": "openai",
  "gpt-5.4-mini": "openai",
  "gpt-5.4-mini-fast": "openai",
  "gpt-5.5": "openai",
  "gpt-5.5-fast": "openai",
  "gpt-5.5-pro": "openai",
  "gpt-5.6-luna": "openai",
  "gpt-5.6-sol": "openai",
  "gpt-5.6-sol-fast": "openai",
  "gpt-5.6-terra": "openai",
  "gpt-6-astra": "openai",
  "gpt-6-luna": "openai",
  "gpt-6-luna-fast": "openai",
  "gpt-6-sol": "openai",
  "gpt-6-sol-fast": "openai",
  "gpt-6.1-sol": "openai",
  "gpt-6.1-sol-ultrafast": "openai",
  "gpt-6.1-terra": "openai",
  "grok-4.5": "xai",
  "grok-4.6": "xai",
  "grok-4.7": "xai",
  "inkling": "fireworks",
  "kimi-k2.5": "fireworks",
  "kimi-k2.6": "fireworks",
  "kimi-k2.7-code": "fireworks",
  "kimi-k3": "fireworks",
  "minimax-m2.5": "fireworks",
  "minimax-m2.7": "fireworks",
  "minimax-m3": "fireworks",
  "minimax-m3.1-flash": "fireworks",
  "mistral-large-4": "mistral",
  "mistral-medium-3.5": "mistral",
  "muse-spark-1.2": "fireworks",
  "muse-spark-1.3": "google",
  "muse-spark-open": "baseten",
  "nemotron-3-ultra": "baseten",
  "nemotron-3.5-super": "baseten",
  "qwen3.8-max": "fireworks",
};

describe("Factory provider choice from Droid 1.3.0", () => {
  it("sends each model to the provider Droid picks", () => {
    for (const [id, provider] of Object.entries(DROID_1_3_0_GLOBAL_PROVIDERS)) {
      expect(upstreamProviderFor(id), id).toBe(provider);
      expect(upstreamProviderFor(`fy/${id}`), `fy/${id}`).toBe(provider);
    }
  });

  it("still picks a provider for models Droid no longer lists", () => {
    expect(upstreamProviderFor("gpt-5.1")).toBe("openai");
    expect(upstreamProviderFor("claude-opus-4-1")).toBe("anthropic");
    expect(upstreamProviderFor("gemini-2.5-pro")).toBe("google");
    expect(upstreamProviderFor("grok-4")).toBe("xai");
    expect(upstreamProviderFor("some-open-model")).toBe("fireworks");
  });
});
