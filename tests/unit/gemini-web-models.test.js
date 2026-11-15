import { describe, expect, it } from "vitest";
import { listPublicGeminiWebCatalog, unionGeminiWebCatalogIds } from "../../src/lib/geminiWebAccounts.js";

const NOW = Date.parse("2026-11-14T12:00:00.000Z");

function row({ id, authUser, sessionId, models, verifiedAt, enabledModels }) {
  return {
    id,
    provider: "gemini-web",
    providerSpecificData: { geminiWebSessionId: sessionId, authUser, enabledModels },
    geminiWebModelCatalog: {
      sessionId,
      authUser,
      cookieRevision: 1,
      models,
      verifiedAt,
    },
  };
}

describe("Gemini Web catalog snapshots", () => {
  it("unions unexpired catalogs across accounts and respects per-row enabledModels", () => {
    const a0 = row({
      id: "a0",
      authUser: "0",
      sessionId: "jar-a",
      verifiedAt: "2026-11-14T11:55:00.000Z",
      models: [{ id: "gemini-quick-answers", name: "Quick answers" }, { id: "gemini-most-complex-work", name: "Most complex work" }],
    });
    const a6 = row({
      id: "a6",
      authUser: "6",
      sessionId: "jar-a",
      verifiedAt: "2026-11-14T11:55:00.000Z",
      models: [{ id: "gemini-quick-answers", name: "Quick answers" }, { id: "gemini-detailed-research", name: "Detailed research" }],
      enabledModels: ["gemini-detailed-research"],
    });
    const b0 = row({
      id: "b0",
      authUser: "0",
      sessionId: "jar-b",
      verifiedAt: "2026-11-14T11:50:00.000Z",
      models: [{ id: "gemini-everyday-help", name: "Everyday help" }],
    });

    expect(unionGeminiWebCatalogIds([a0, a6, b0], NOW)).toEqual([
      "gemini-quick-answers",
      "gemini-most-complex-work",
      "gemini-detailed-research",
      "gemini-everyday-help",
    ]);
  });

  it("drops expired or revision-mismatched snapshots", () => {
    const expired = row({
      id: "old",
      authUser: "0",
      sessionId: "jar-a",
      verifiedAt: "2026-11-14T11:00:00.000Z",
      models: [{ id: "gemini-quick-answers", name: "Quick answers" }],
    });
    const mismatched = row({
      id: "stale",
      authUser: "0",
      sessionId: "jar-a",
      verifiedAt: "2026-11-14T11:55:00.000Z",
      models: [{ id: "gemini-everyday-help", name: "Everyday help" }],
    });
    mismatched.geminiWebModelCatalog.sessionId = "other-jar";

    expect(listPublicGeminiWebCatalog(expired, NOW)).toBeNull();
    expect(listPublicGeminiWebCatalog(mismatched, NOW)).toBeNull();
    expect(unionGeminiWebCatalogIds([expired, mismatched], NOW)).toEqual([]);
  });
});
