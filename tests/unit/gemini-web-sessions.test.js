import { describe, it, expect, beforeEach, afterAll } from "vitest";
import * as crypto from "node:crypto";
import { setupGeminiWebDb } from "../helpers/geminiWebDb.js";

const fixture = await setupGeminiWebDb();

const repo = await import("../../src/lib/db/repos/geminiWebSessionsRepo.js");
const connections = await import("../../src/lib/db/repos/connectionsRepo.js");
const database = await import("../../src/lib/db/index.js");
const {
  normalizeGeminiCookieInput,
  normalizeGeminiValidationCookie,
} = await import("../../open-sse/utils/geminiCookies.js");

const T0 = "2026-11-14T08:00:00.000Z";
const T1 = "2026-11-14T09:00:00.000Z";
const T2 = "2026-11-14T10:00:00.000Z";

const HEADER_A =
  "__Secure-1PSID=psid-alpha-0001; __Secure-1PSIDTS=psidts-alpha-0001; NID=nid-alpha";
const HEADER_A_ROTATED =
  "__Secure-1PSID=psid-alpha-0001; __Secure-1PSIDTS=psidts-alpha-0002; NID=nid-alpha";
const HEADER_A_OTHER_NID =
  "__Secure-1PSID=psid-alpha-0001; __Secure-1PSIDTS=psidts-alpha-0001; NID=nid-alpha-other";
const HEADER_B =
  "__Secure-1PSID=psid-bravo-0002; __Secure-1PSIDTS=psidts-bravo-0002; NID=nid-bravo";
const HEADER_C =
  "__Secure-1PSID=psid-charlie-0003; __Secure-1PSIDTS=psidts-charlie-0003; NID=nid-charlie";

// Two legacy jars share the PSID and the pre-rotation PSIDTS but carry
// different browser cookies, which is exactly the fan-out pair rule.
const SHARED_OLD_NID_ALPHA =
  "__Secure-1PSID=psid-shared-9001; __Secure-1PSIDTS=psidts-shared-old; NID=nid-alpha";
const SHARED_OLD_NID_CHARLIE =
  "__Secure-1PSID=psid-shared-9001; __Secure-1PSIDTS=psidts-shared-old; NID=nid-charlie";
const SHARED_ROTATED =
  "__Secure-1PSID=psid-shared-9001; __Secure-1PSIDTS=psidts-shared-new; NID=nid-alpha";

function cookiePairs(header) {
  return header
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const index = part.indexOf("=");
      return [part.slice(0, index), part.slice(index + 1)];
    });
}

function cookieValue(header, name) {
  const pair = cookiePairs(header).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return pair ? pair[1] : null;
}

function fingerprintOf(header) {
  const psid = cookieValue(header, "__Secure-1PSID");
  return crypto.createHash("sha256").update(psid, "utf8").digest("hex").slice(0, 12);
}

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the operation to reject");
}

function expectCookieError(fn) {
  let error = null;
  try {
    fn();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeTruthy();
  expect(error.code).toBe("GEMINI_WEB_COOKIE_INVALID");
}

function saveSession(overrides = {}) {
  return repo.saveGeminiWebSession({
    name: "Session",
    cookieHeader: HEADER_A,
    source: "paste",
    ...overrides,
  });
}

function accountSet({ session, accounts, verifiedMembers, expectedRevision = null }) {
  return repo.commitGeminiWebAccountSet({
    session,
    accounts,
    verifiedMembers,
    expectedRevision,
  });
}

function createNewJar(cookieHeader, accounts, name = "Work") {
  return accountSet({
    session: { name, cookieHeader, source: "paste" },
    accounts,
    verifiedMembers: accounts.map((account) => ({ connectionId: null, authUser: account.authUser })),
  });
}

beforeEach(() => {
  fixture.clear();
});

afterAll(() => {
  fixture.teardown();
});

describe("Gemini Web cookie input normalization", () => {
  it("strips a pasted Cookie: prefix and canonicalizes whitespace and order", () => {
    expect(
      normalizeGeminiCookieInput(
        "Cookie: NID=nid-alpha;   __Secure-1PSIDTS=psidts-alpha-0001 ;__Secure-1PSID=psid-alpha-0001"
      )
    ).toBe(HEADER_A);
  });

  it("keeps the bare-PSID legacy input shape", () => {
    expect(normalizeGeminiCookieInput(" psid-bare-0001 ")).toBe(
      "__Secure-1PSID=psid-bare-0001"
    );
  });

  it("keeps the legacy JSON-object input shape", () => {
    expect(
      normalizeGeminiCookieInput(
        '{"cookies":{"NID":"nid-alpha","__Secure-1PSIDTS":"psidts-alpha-0001","__Secure-1PSID":"psid-alpha-0001"}}'
      )
    ).toBe(HEADER_A);
  });

  it("preserves values that contain equals signs and every supplied cookie name", () => {
    const normalized = normalizeGeminiCookieInput(
      "SID=abc==; __Secure-1PSID=psid-alpha-0001; APISID=apisid-value; SAPISID=sapisid-value"
    );
    expect(cookieValue(normalized, "SID")).toBe("abc==");
    expect(cookieValue(normalized, "APISID")).toBe("apisid-value");
    expect(cookieValue(normalized, "SAPISID")).toBe("sapisid-value");
    expect(cookieValue(normalized, "__Secure-1PSID")).toBe("psid-alpha-0001");
  });

  it("produces one canonical form for reordered and respaced headers", () => {
    const reordered = "NID=nid-alpha; __Secure-1PSID=psid-alpha-0001; __Secure-1PSIDTS=psidts-alpha-0001";
    expect(normalizeGeminiCookieInput(reordered)).toBe(HEADER_A);
    expect(normalizeGeminiCookieInput(HEADER_A)).toBe(HEADER_A);
  });

  it("rejects control characters instead of passing them to an upstream request", () => {
    expectCookieError(() => normalizeGeminiCookieInput("__Secure-1PSID=abc\r\nX-Evil: 1"));
    expectCookieError(() => normalizeGeminiCookieInput("__Secure-1PSID=abc\nNID=nid"));
    expectCookieError(() => normalizeGeminiCookieInput("__Secure-1PSID=abc\0def"));
  });

  it("rejects malformed cookie names and header segments", () => {
    expectCookieError(() => normalizeGeminiCookieInput("bad name=value"));
    expectCookieError(() => normalizeGeminiCookieInput("bad@name=value"));
    expectCookieError(() => normalizeGeminiCookieInput("=value"));
    expectCookieError(() => normalizeGeminiCookieInput("__Secure-1PSID=abc; stray"));
    expectCookieError(() => normalizeGeminiCookieInput('{"__Secure-1PSID":'));
  });

  it("validates a full header while still accepting a bare PSID", () => {
    expect(
      normalizeGeminiValidationCookie(
        "Cookie: NID=nid-alpha; __Secure-1PSID=psid-alpha-0001"
      )
    ).toBe("__Secure-1PSID=psid-alpha-0001; NID=nid-alpha");
    expect(normalizeGeminiValidationCookie("psid-bare-0001")).toBe(
      "__Secure-1PSID=psid-bare-0001"
    );
  });

  it("returns null from validation when no nonempty PSID is present", () => {
    expect(normalizeGeminiValidationCookie("NID=nid-alpha; APISID=apisid")).toBeNull();
    expect(normalizeGeminiValidationCookie("__Secure-1PSID=; NID=nid-alpha")).toBeNull();
  });

  it("rejects invalid validation input the same way as the header normalizer", () => {
    expectCookieError(() => normalizeGeminiValidationCookie("__Secure-1PSID=abc\r\nX-Evil: 1"));
    expectCookieError(() => normalizeGeminiValidationCookie("bad name=value"));
  });
});

describe("Gemini Web session jars", () => {
  it("stores one private record with a PSID fingerprint and first revision", async () => {
    const saved = await saveSession({
      cookieHeader:
        "  NID = nid-alpha ; __Secure-1PSIDTS=psidts-alpha-0001 ;; __Secure-1PSID=psid-alpha-0001 ",
    });

    expect(saved.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(saved.name).toBe("Session");
    expect(saved.cookieHeader).toBe(HEADER_A);
    expect(saved.fingerprint).toBe(fingerprintOf(HEADER_A));
    expect(saved.revision).toBe(1);
    expect(saved.source).toBe("paste");
    expect(saved.lastRotatedAt).toBeNull();
    expect(saved.createdAt).toBe(saved.updatedAt);
    expect(Number.isNaN(Date.parse(saved.createdAt))).toBe(false);

    expect(await repo.getGeminiWebSession(saved.id)).toEqual(saved);
    expect(await repo.listGeminiWebSessions()).toEqual([saved]);
  });

  it("commits updates only against the expected revision", async () => {
    const saved = await saveSession();
    const updated = await repo.saveGeminiWebSession(
      {
        id: saved.id,
        name: "Renamed",
        cookieHeader: HEADER_B,
        source: "web-login",
        lastRotatedAt: T1,
      },
      { expectedRevision: 1 }
    );

    expect(updated.id).toBe(saved.id);
    expect(updated.name).toBe("Renamed");
    expect(updated.cookieHeader).toBe(HEADER_B);
    expect(updated.fingerprint).toBe(fingerprintOf(HEADER_B));
    expect(updated.revision).toBe(2);
    expect(updated.source).toBe("web-login");
    expect(updated.lastRotatedAt).toBe(T1);
    expect(updated.createdAt).toBe(saved.createdAt);

    const stale = await rejection(
      repo.saveGeminiWebSession(
        { id: saved.id, name: "Stale", cookieHeader: HEADER_C, source: "paste" },
        { expectedRevision: 1 }
      )
    );
    expect(stale.code).toBe("GEMINI_WEB_SESSION_CONFLICT");
    expect(await repo.getGeminiWebSession(saved.id)).toEqual(updated);
  });

  it("throws NOT_FOUND when an update names an absent record", async () => {
    const missingId = "00000000-0000-4000-8000-000000000000";
    const error = await rejection(
      repo.saveGeminiWebSession(
        { id: missingId, name: "Missing", cookieHeader: HEADER_A, source: "paste" },
        { expectedRevision: 1 }
      )
    );
    expect(error.code).toBe("GEMINI_WEB_SESSION_NOT_FOUND");
    expect(await repo.listGeminiWebSessions()).toEqual([]);
  });

  it("refuses records whose cookie cannot produce a PSID fingerprint", async () => {
    const noPsid = await rejection(saveSession({ cookieHeader: "NID=nid-only" }));
    expect(noPsid.code).toBe("GEMINI_WEB_COOKIE_INVALID");

    const malformed = await rejection(saveSession({ cookieHeader: "__Secure-1PSID=a\r\nb" }));
    expect(malformed.code).toBe("GEMINI_WEB_COOKIE_INVALID");
    expect(await repo.listGeminiWebSessions()).toEqual([]);
  });

  it("commits a manual cookie replacement against one jar only", async () => {
    const alpha = await saveSession({ name: "Alpha", cookieHeader: HEADER_A });
    const bravo = await saveSession({ name: "Bravo", cookieHeader: HEADER_B });

    const updated = await repo.commitGeminiWebCookieUpdate(alpha.id, {
      cookieHeader: HEADER_A_ROTATED,
      expectedRevision: alpha.revision,
      source: "paste",
      lastRotatedAt: T1,
    });

    expect(updated.cookieHeader).toBe(HEADER_A_ROTATED);
    expect(updated.revision).toBe(2);
    expect(updated.lastRotatedAt).toBe(T1);
    expect(await repo.getGeminiWebSession(bravo.id)).toEqual(bravo);

    const stale = await rejection(
      repo.commitGeminiWebCookieUpdate(alpha.id, {
        cookieHeader: HEADER_C,
        expectedRevision: alpha.revision,
        source: "rotation",
        lastRotatedAt: T2,
      })
    );
    expect(stale.code).toBe("GEMINI_WEB_SESSION_CONFLICT");
    expect(await repo.getGeminiWebSession(alpha.id)).toEqual(updated);
  });

  it("throws NOT_FOUND when committing a cookie update for an absent jar", async () => {
    const error = await rejection(
      repo.commitGeminiWebCookieUpdate("00000000-0000-4000-8000-000000000000", {
        cookieHeader: HEADER_A_ROTATED,
        expectedRevision: 1,
        source: "rotation",
        lastRotatedAt: T1,
      })
    );
    expect(error.code).toBe("GEMINI_WEB_SESSION_NOT_FOUND");
  });

  it("fans a rotation PSIDTS out to jars with the same PSID and previous PSIDTS", async () => {
    const alpha = await saveSession({ name: "Alpha", cookieHeader: SHARED_OLD_NID_ALPHA });
    const charlie = await saveSession({ name: "Charlie", cookieHeader: SHARED_OLD_NID_CHARLIE });

    await repo.commitGeminiWebCookieUpdate(alpha.id, {
      cookieHeader: SHARED_ROTATED,
      expectedRevision: alpha.revision,
      source: "rotation",
      lastRotatedAt: T1,
    });

    const target = await repo.getGeminiWebSession(charlie.id);
    expect(target.cookieHeader).toBe(
      "__Secure-1PSID=psid-shared-9001; __Secure-1PSIDTS=psidts-shared-new; NID=nid-charlie"
    );
    expect(target.revision).toBe(charlie.revision + 1);
    expect(target.source).toBe("paste");
  });

  it("never overwrites a jar whose PSIDTS already moved on", async () => {
    const alpha = await saveSession({ name: "Alpha", cookieHeader: SHARED_OLD_NID_ALPHA });
    const charlie = await saveSession({ name: "Charlie", cookieHeader: SHARED_OLD_NID_CHARLIE });

    const manuallyUpdated = await repo.commitGeminiWebCookieUpdate(charlie.id, {
      cookieHeader:
        "__Secure-1PSID=psid-shared-9001; __Secure-1PSIDTS=psidts-shared-newer; NID=nid-charlie",
      expectedRevision: charlie.revision,
      source: "paste",
      lastRotatedAt: T1,
    });

    await repo.commitGeminiWebCookieUpdate(alpha.id, {
      cookieHeader: SHARED_ROTATED,
      expectedRevision: alpha.revision,
      source: "rotation",
      lastRotatedAt: T2,
    });

    const target = await repo.getGeminiWebSession(charlie.id);
    expect(target.cookieHeader).toBe(manuallyUpdated.cookieHeader);
    expect(target.revision).toBe(manuallyUpdated.revision);
  });

  it("copies only PSIDTS during fan-out, leaving each jar's other cookies alone", async () => {
    const alpha = await saveSession({ name: "Alpha", cookieHeader: SHARED_OLD_NID_ALPHA });
    const charlie = await saveSession({ name: "Charlie", cookieHeader: SHARED_OLD_NID_CHARLIE });

    await repo.commitGeminiWebCookieUpdate(alpha.id, {
      cookieHeader:
        "__Secure-1PSID=psid-shared-9001; __Secure-1PSIDTS=psidts-shared-new; NID=nid-alpha-new; AEC=aec-alpha",
      expectedRevision: alpha.revision,
      source: "rotation",
      lastRotatedAt: T1,
    });

    const target = await repo.getGeminiWebSession(charlie.id);
    expect(target.cookieHeader).toBe(
      "__Secure-1PSID=psid-shared-9001; __Secure-1PSIDTS=psidts-shared-new; NID=nid-charlie"
    );
    expect(cookieValue(target.cookieHeader, "AEC")).toBeNull();
    expect(cookieValue(target.cookieHeader, "NID")).toBe("nid-charlie");
  });

  it("advances a revision only when persisted cookie metadata changed", async () => {
    const saved = await saveSession({ cookieHeader: HEADER_A, lastRotatedAt: T0 });

    const unchanged = await repo.commitGeminiWebCookieUpdate(saved.id, {
      cookieHeader: HEADER_A,
      expectedRevision: saved.revision,
      source: "paste",
      lastRotatedAt: T0,
    });
    expect(unchanged.revision).toBe(saved.revision);

    const metadataChanged = await repo.commitGeminiWebCookieUpdate(saved.id, {
      cookieHeader: HEADER_A,
      expectedRevision: unchanged.revision,
      source: "paste",
      lastRotatedAt: T1,
    });
    expect(metadataChanged.revision).toBe(saved.revision + 1);
  });
});

describe("Gemini Web account sets", () => {
  it("creates one jar plus one routable connection per verified slot", async () => {
    const result = await createNewJar(
      HEADER_A,
      [
        { authUser: "0", name: "Work / 0", proxyPoolId: "pool-alpha" },
        { authUser: "2" },
      ],
      "Work"
    );

    expect(result.session.name).toBe("Work");
    expect(result.session.revision).toBe(1);
    expect(await repo.listGeminiWebSessions()).toEqual([result.session]);
    expect(result.connections).toHaveLength(2);

    const bySlot = Object.fromEntries(
      result.connections.map((connection) => [connection.providerSpecificData.authUser, connection])
    );
    const slotZero = await connections.getProviderConnectionById(bySlot["0"].id);
    const slotTwo = await connections.getProviderConnectionById(bySlot["2"].id);

    expect(slotZero.provider).toBe("gemini-web");
    expect(slotZero.authType).toBe("cookie");
    expect(slotZero.apiKey).toBe("");
    expect(slotZero.isActive).toBe(true);
    expect(slotZero.name).toBe("Work / 0");
    expect(slotZero.priority).toBe(1);
    expect(slotZero.providerSpecificData.geminiWebSessionId).toBe(result.session.id);
    expect(slotZero.providerSpecificData.authUser).toBe("0");
    expect(slotZero.providerSpecificData.proxyPoolId).toBe("pool-alpha");
    expect(slotZero.providerSpecificData.cookie).toBeUndefined();
    expect(slotZero.providerSpecificData["__Secure-1PSID"]).toBeUndefined();

    expect(slotTwo.priority).toBe(2);
    expect(slotTwo.providerSpecificData.authUser).toBe("2");
    expect(slotTwo.providerSpecificData.geminiWebSessionId).toBe(result.session.id);
  });

  it("keeps the explicit slot 0 distinct from the legacy root slot", async () => {
    const explicitZero = await createNewJar(HEADER_A, [{ authUser: "0" }], "Explicit");
    const root = await createNewJar(HEADER_B, [{ authUser: "" }], "Root");

    expect(explicitZero.connections[0].providerSpecificData.authUser).toBe("0");
    expect(root.connections[0].providerSpecificData.authUser).toBe("");

    const storedZero = await connections.getProviderConnectionById(explicitZero.connections[0].id);
    const storedRoot = await connections.getProviderConnectionById(root.connections[0].id);
    expect(storedZero.providerSpecificData.authUser).toBe("0");
    expect(storedRoot.providerSpecificData.authUser).toBe("");
  });

  it("reuses the committed entities for repeated concurrent identical creation", async () => {
    const request = () => ({
      session: { name: "Work", cookieHeader: HEADER_A, source: "paste" },
      accounts: [{ authUser: "0" }, { authUser: "2" }],
      verifiedMembers: [
        { connectionId: null, authUser: "0" },
        { connectionId: null, authUser: "2" },
      ],
      expectedRevision: null,
    });

    const [first, second] = await Promise.all([
      repo.commitGeminiWebAccountSet(request()),
      repo.commitGeminiWebAccountSet(request()),
    ]);

    expect(first.session.id).toBe(second.session.id);
    expect(await repo.listGeminiWebSessions()).toHaveLength(1);
    const all = await connections.getProviderConnections({ provider: "gemini-web" });
    expect(all).toHaveLength(2);
    expect(all.map((connection) => connection.providerSpecificData.authUser).sort()).toEqual([
      "0",
      "2",
    ]);
  });

  it("rejects a new jar whose PSID belongs to another jar, naming the existing session", async () => {
    const first = await createNewJar(HEADER_A, [{ authUser: "0" }], "First");

    const error = await rejection(
      createNewJar(HEADER_A_OTHER_NID, [{ authUser: "0" }], "Conflicting")
    );
    expect(error.code).toBe("GEMINI_WEB_SESSION_CONFLICT");
    expect(error.existingSessionId).toBe(first.session.id);
    expect(await repo.listGeminiWebSessions()).toEqual([first.session]);
    expect(await connections.getProviderConnections({ provider: "gemini-web" })).toHaveLength(1);
  });

  it("adds a slot without altering existing names, priorities or proxies", async () => {
    const created = await createNewJar(
      HEADER_A,
      [{ authUser: "0", name: "Custom zero", proxyPoolId: "pool-alpha" }],
      "Work"
    );
    const slotZero = created.connections[0];

    const added = await accountSet({
      session: { id: created.session.id },
      accounts: [{ authUser: "0" }, { authUser: "2", proxyPoolId: "pool-bravo" }],
      verifiedMembers: [
        { connectionId: slotZero.id, authUser: "0" },
        { connectionId: null, authUser: "2" },
      ],
      expectedRevision: created.session.revision,
    });

    expect(added.session.revision).toBe(created.session.revision + 1);
    expect(added.connections).toHaveLength(2);

    const unchanged = await connections.getProviderConnectionById(slotZero.id);
    expect(unchanged.name).toBe("Custom zero");
    expect(unchanged.priority).toBe(1);
    expect(unchanged.providerSpecificData.proxyPoolId).toBe("pool-alpha");

    const newSlot = added.connections.find(
      (connection) => connection.providerSpecificData.authUser === "2"
    );
    expect(newSlot.priority).toBe(2);
    expect(newSlot.providerSpecificData.proxyPoolId).toBe("pool-bravo");
  });

  it("rejects stale revisions and membership that changed after verification", async () => {
    const created = await createNewJar(HEADER_A, [{ authUser: "0" }], "Work");
    const slotZero = created.connections[0];

    const stale = await rejection(
      accountSet({
        session: { id: created.session.id },
        accounts: [{ authUser: "0" }, { authUser: "2" }],
        verifiedMembers: [
          { connectionId: slotZero.id, authUser: "0" },
          { connectionId: null, authUser: "2" },
        ],
        expectedRevision: created.session.revision - 1,
      })
    );
    expect(stale.code).toBe("GEMINI_WEB_SESSION_CONFLICT");

    await connections.deleteProviderConnection(slotZero.id);
    const membershipChanged = await rejection(
      accountSet({
        session: { id: created.session.id },
        accounts: [{ authUser: "0" }],
        verifiedMembers: [{ connectionId: slotZero.id, authUser: "0" }],
        expectedRevision: created.session.revision,
      })
    );
    expect(membershipChanged.code).toBe("GEMINI_WEB_SESSION_CONFLICT");
    expect(await connections.getProviderConnections({ provider: "gemini-web" })).toHaveLength(0);
  });

  it("keeps independent jars with the same slot number isolated", async () => {
    const alpha = await createNewJar(HEADER_A, [{ authUser: "0" }], "Alpha");
    const bravo = await createNewJar(HEADER_B, [{ authUser: "0" }], "Bravo");

    expect(alpha.session.id).not.toBe(bravo.session.id);
    const alphaConnection = await connections.getProviderConnectionById(alpha.connections[0].id);
    const bravoConnection = await connections.getProviderConnectionById(bravo.connections[0].id);
    expect(alphaConnection.providerSpecificData.geminiWebSessionId).toBe(alpha.session.id);
    expect(bravoConnection.providerSpecificData.geminiWebSessionId).toBe(bravo.session.id);
    expect(alphaConnection.providerSpecificData.geminiWebSessionId).not.toBe(
      bravoConnection.providerSpecificData.geminiWebSessionId
    );
    expect((await repo.getGeminiWebSession(alpha.session.id)).cookieHeader).toBe(HEADER_A);
    expect((await repo.getGeminiWebSession(bravo.session.id)).cookieHeader).toBe(HEADER_B);
  });
});

describe("Gemini Web session deletion", () => {
  it("refuses to delete a jar that still owns routable connections", async () => {
    const created = await createNewJar(HEADER_A, [{ authUser: "0" }], "Work");

    const error = await rejection(repo.deleteGeminiWebSession(created.session.id));
    expect(error.code).toBe("GEMINI_WEB_SESSION_IN_USE");
    expect(await repo.getGeminiWebSession(created.session.id)).toEqual(created.session);
    expect(await connections.getProviderConnectionById(created.connections[0].id)).toBeTruthy();
  });

  it("deletes an unreferenced jar and reports absent ids", async () => {
    const saved = await saveSession();
    expect(await repo.deleteGeminiWebSession(saved.id)).toBe(true);
    expect(await repo.getGeminiWebSession(saved.id)).toBeNull();
    expect(await repo.deleteGeminiWebSession(saved.id)).toBe(false);
  });

  it("detaches one account, reorders priorities and keeps siblings and the jar", async () => {
    const created = await createNewJar(
      HEADER_A,
      [{ authUser: "0" }, { authUser: "2" }],
      "Work"
    );
    const [slotZero, slotTwo] = created.connections;

    expect(await repo.detachGeminiWebAccount(slotZero.id)).toBe(true);
    expect(await connections.getProviderConnectionById(slotZero.id)).toBeNull();

    const survivor = await connections.getProviderConnectionById(slotTwo.id);
    expect(survivor).toBeTruthy();
    expect(survivor.priority).toBe(1);
    expect(survivor.providerSpecificData.geminiWebSessionId).toBe(created.session.id);

    const jar = await repo.getGeminiWebSession(created.session.id);
    expect(jar).not.toBeNull();
    expect(jar.revision).toBe(created.session.revision + 1);
    expect(await repo.detachGeminiWebAccount(slotZero.id)).toBe(false);
  });
});

describe("Gemini Web legacy migration", () => {
  async function createLegacyConnection(data) {
    return connections.createProviderConnection({
      provider: "gemini-web",
      authType: "cookie",
      ...data,
    });
  }

  it("promotes legacy credentials once and preserves unrelated connection data", async () => {
    const cookieless = await createLegacyConnection({ name: "Needs Recapture" });
    const sharedOne = await createLegacyConnection({
      name: "Legacy Shared One",
      apiKey: "NID=nid-legacy; __Secure-1PSID=psid-legacy-1; __Secure-1PSIDTS=psidts-legacy-1",
    });
    const sharedTwo = await createLegacyConnection({
      name: "Legacy Shared Two",
      providerSpecificData: {
        cookie:
          "Cookie: __Secure-1PSIDTS=psidts-legacy-1; NID=nid-legacy; __Secure-1PSID=psid-legacy-1",
        proxyPoolId: "pool-legacy",
      },
    });
    const separate = await createLegacyConnection({
      name: "Legacy Separate",
      providerSpecificData: {
        "__Secure-1PSID": "psid-legacy-2",
        "__Secure-1PSIDTS": "psidts-legacy-2",
        proxyPoolId: "pool-legacy-two",
      },
    });

    const beforeById = new Map(
      (await connections.getProviderConnections({ provider: "gemini-web" })).map((connection) => [
        connection.id,
        connection,
      ])
    );

    const first = await repo.migrateLegacyGeminiWebConnections();
    expect(first.createdSessionIds).toHaveLength(2);
    expect(first.migratedConnectionIds.sort()).toEqual(
      [sharedOne.id, sharedTwo.id, separate.id].sort()
    );
    expect(first.skippedConnectionIds).toEqual([cookieless.id]);

    const sessions = await repo.listGeminiWebSessions();
    expect(sessions).toHaveLength(2);
    const sharedSession = sessions.find((session) => session.cookieHeader.includes("psid-legacy-1"));
    const separateSession = sessions.find((session) =>
      session.cookieHeader.includes("psid-legacy-2")
    );
    expect(sharedSession.fingerprint).toBe(fingerprintOf(sharedSession.cookieHeader));
    expect(separateSession.fingerprint).toBe(fingerprintOf(separateSession.cookieHeader));

    const migratedOne = await connections.getProviderConnectionById(sharedOne.id);
    const migratedTwo = await connections.getProviderConnectionById(sharedTwo.id);
    const migratedSeparate = await connections.getProviderConnectionById(separate.id);

    expect(migratedOne.apiKey).toBeUndefined();
    expect(migratedOne.providerSpecificData.geminiWebSessionId).toBe(sharedSession.id);
    expect(migratedOne.providerSpecificData.authUser).toBe("");
    expect(migratedTwo.providerSpecificData.geminiWebSessionId).toBe(sharedSession.id);
    expect(migratedTwo.providerSpecificData.cookie).toBeUndefined();
    expect(migratedTwo.providerSpecificData.proxyPoolId).toBe("pool-legacy");
    expect(migratedSeparate.providerSpecificData["__Secure-1PSID"]).toBeUndefined();
    expect(migratedSeparate.providerSpecificData["__Secure-1PSIDTS"]).toBeUndefined();
    expect(migratedSeparate.providerSpecificData.geminiWebSessionId).toBe(separateSession.id);

    for (const connection of [migratedOne, migratedTwo, migratedSeparate]) {
      const previous = beforeById.get(connection.id);
      expect(connection.name).toBe(previous.name);
      expect(connection.priority).toBe(previous.priority);
      expect(connection.isActive).toBe(previous.isActive);
    }

    const recapture = await connections.getProviderConnectionById(cookieless.id);
    expect(recapture).toBeTruthy();
    expect(recapture.priority).toBe(1);
    expect(recapture.providerSpecificData?.geminiWebSessionId).toBeUndefined();
    expect(migratedOne.priority).toBe(2);

    const second = await repo.migrateLegacyGeminiWebConnections();
    expect(second.createdSessionIds).toEqual([]);
    expect(second.migratedConnectionIds).toEqual([]);
    expect(second.skippedConnectionIds).toEqual([cookieless.id]);
    expect(await repo.listGeminiWebSessions()).toEqual(sessions);
  });

  it("keeps same-PSID legacy jars separate instead of merging browser flags", async () => {
    await createLegacyConnection({
      name: "Legacy Alpha",
      apiKey: SHARED_OLD_NID_ALPHA,
    });
    await createLegacyConnection({
      name: "Legacy Charlie",
      providerSpecificData: { cookie: SHARED_OLD_NID_CHARLIE },
    });

    await repo.migrateLegacyGeminiWebConnections();
    const sessions = await repo.listGeminiWebSessions();
    expect(sessions).toHaveLength(2);
    expect(new Set(sessions.map((session) => session.cookieHeader))).toEqual(
      new Set([SHARED_OLD_NID_ALPHA, SHARED_OLD_NID_CHARLIE])
    );
  });

  it("adds a slot to a legacy jar without tripping same-PSID uniqueness", async () => {
    const alphaRow = await createLegacyConnection({
      name: "Legacy Alpha",
      apiKey: SHARED_OLD_NID_ALPHA,
    });
    const charlieRow = await createLegacyConnection({
      name: "Legacy Charlie",
      providerSpecificData: { cookie: SHARED_OLD_NID_CHARLIE },
    });

    await repo.migrateLegacyGeminiWebConnections();
    const sessions = await repo.listGeminiWebSessions();
    const alphaSession = sessions.find((session) => session.cookieHeader === SHARED_OLD_NID_ALPHA);
    const alphaConnection = await connections.getProviderConnectionById(alphaRow.id);

    const added = await accountSet({
      session: { id: alphaSession.id },
      accounts: [{ authUser: "" }, { authUser: "2" }],
      verifiedMembers: [
        { connectionId: alphaConnection.id, authUser: "" },
        { connectionId: null, authUser: "2" },
      ],
      expectedRevision: alphaSession.revision,
    });

    expect(added.connections).toHaveLength(2);
    expect(await repo.listGeminiWebSessions()).toHaveLength(2);
    expect(await connections.getProviderConnectionById(charlieRow.id)).toBeTruthy();
  });

  it("uses the executor credential precedence when several legacy copies exist", async () => {
    await createLegacyConnection({
      name: "Precedence",
      apiKey: HEADER_A,
      providerSpecificData: { cookie: HEADER_B },
    });

    await repo.migrateLegacyGeminiWebConnections();
    const sessions = await repo.listGeminiWebSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].cookieHeader).toBe(HEADER_A);
    expect(sessions[0].source).toBe("legacy");
  });

  it("promotes a bare legacy PSID without requiring PSIDTS", async () => {
    const legacy = await createLegacyConnection({
      name: "Bare PSID",
      providerSpecificData: { "__Secure-1PSID": "psid-bare-legacy" },
    });

    await repo.migrateLegacyGeminiWebConnections();
    const sessions = await repo.listGeminiWebSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].cookieHeader).toBe("__Secure-1PSID=psid-bare-legacy");
    const migrated = await connections.getProviderConnectionById(legacy.id);
    expect(migrated.providerSpecificData.geminiWebSessionId).toBe(sessions[0].id);
  });
});

describe("Gemini Web model catalog snapshots", () => {
  it("stores only public model metadata at the verified session revision", async () => {
    const created = await createNewJar(HEADER_A, [{ authUser: "0" }], "Work");
    const connection = created.connections[0];

    await repo.recordGeminiWebModels(connection.id, {
      sessionId: created.session.id,
      authUser: "0",
      cookieRevision: created.session.revision,
      models: [
        {
          id: "gemini-auto",
          name: "Auto",
          modelId: "internal-routing-id",
          modelNumber: 79,
          capacity: 4,
          capacityField: "capacity",
          token: "not-a-public-field",
        },
        { id: "gemini-pro", name: "Pro" },
      ],
      verifiedAt: T1,
    });

    const stored = await connections.getProviderConnectionById(connection.id);
    expect(stored.geminiWebModelCatalog).toEqual({
      sessionId: created.session.id,
      authUser: "0",
      cookieRevision: created.session.revision,
      models: [
        { id: "gemini-auto", name: "Auto" },
        { id: "gemini-pro", name: "Pro" },
      ],
      verifiedAt: T1,
    });
    expect(JSON.stringify(stored.geminiWebModelCatalog)).not.toContain("internal-routing-id");
    expect(JSON.stringify(stored.geminiWebModelCatalog)).not.toContain("not-a-public-field");
    expect((await repo.getGeminiWebSession(created.session.id)).revision).toBe(
      created.session.revision
    );
  });

  it("refuses a snapshot recorded against a stale revision, wrong slot or wrong jar", async () => {
    const created = await createNewJar(HEADER_A, [{ authUser: "0" }], "Work");
    const connection = created.connections[0];
    const snapshot = {
      sessionId: created.session.id,
      authUser: "0",
      cookieRevision: created.session.revision + 5,
      models: [{ id: "gemini-auto", name: "Auto" }],
      verifiedAt: T1,
    };

    expect(await rejection(repo.recordGeminiWebModels(connection.id, snapshot))).toBeTruthy();
    expect(await rejection(
      repo.recordGeminiWebModels(connection.id, {
        ...snapshot,
        cookieRevision: created.session.revision,
        authUser: "2",
      })
    )).toBeTruthy();
    expect(await rejection(
      repo.recordGeminiWebModels(connection.id, {
        ...snapshot,
        cookieRevision: created.session.revision,
        sessionId: "00000000-0000-4000-8000-000000000000",
      })
    )).toBeTruthy();
    expect(await rejection(
      repo.recordGeminiWebModels("00000000-0000-4000-8000-000000000000", {
        ...snapshot,
        cookieRevision: created.session.revision,
      })
    )).toBeTruthy();

    const stored = await connections.getProviderConnectionById(connection.id);
    expect(stored.geminiWebModelCatalog).toBeUndefined();
  });
});

describe("Gemini Web session backup round-trips", () => {
  it("exports the private jar set and replaces the stored set on import", async () => {
    const alpha = await createNewJar(HEADER_A, [{ authUser: "0" }, { authUser: "2" }], "Alpha");
    const bravo = await createNewJar(HEADER_B, [{ authUser: "0" }], "Bravo");
    await repo.recordGeminiWebModels(alpha.connections[0].id, {
      sessionId: alpha.session.id,
      authUser: "0",
      cookieRevision: alpha.session.revision,
      models: [{ id: "gemini-auto", name: "Auto" }],
      verifiedAt: T1,
    });

    const exported = await database.exportDb();
    const exportedSessions = await repo.listGeminiWebSessions();
    expect(exported.geminiWebSessions).toEqual(exportedSessions);
    expect(exported.geminiWebSessions).toHaveLength(2);
    expect(exported.geminiWebSessions.map((session) => session.cookieHeader).sort()).toEqual(
      [HEADER_A, HEADER_B].sort()
    );

    const extra = await createNewJar(HEADER_C, [{ authUser: "0" }], "Extra");
    expect(await repo.listGeminiWebSessions()).toHaveLength(3);

    const restored = await database.importDb(exported);
    expect(restored.geminiWebSessions).toEqual(exportedSessions);
    expect(await repo.listGeminiWebSessions()).toEqual(exportedSessions);
    expect(await repo.getGeminiWebSession(extra.session.id)).toBeNull();
    expect(await repo.getGeminiWebSession(bravo.session.id)).toEqual(bravo.session);

    const restoredConnection = await connections.getProviderConnectionById(alpha.connections[0].id);
    expect(restoredConnection).toBeTruthy();
    expect(restoredConnection.providerSpecificData.geminiWebSessionId).toBe(alpha.session.id);
    expect(restoredConnection.geminiWebModelCatalog).toBeUndefined();
  });

  it("accepts an older backup without the session property and leaves no stale jar", async () => {
    await createNewJar(HEADER_A, [{ authUser: "0" }], "Alpha");
    expect(await repo.listGeminiWebSessions()).toHaveLength(1);

    await database.importDb({ providerConnections: [] });
    expect(await repo.listGeminiWebSessions()).toEqual([]);
  });

  it("rejects broken session records and dangling references before mutating the database", async () => {
    const created = await createNewJar(HEADER_A, [{ authUser: "0" }], "Alpha");
    const beforeSessions = await repo.listGeminiWebSessions();
    const beforeConnections = await connections.getProviderConnections({ provider: "gemini-web" });

    await expect(
      database.importDb({
        providerConnections: [],
        geminiWebSessions: [{ id: "broken" }],
      })
    ).rejects.toThrow();
    expect(await repo.listGeminiWebSessions()).toEqual(beforeSessions);
    expect(await connections.getProviderConnections({ provider: "gemini-web" })).toEqual(
      beforeConnections
    );

    await expect(
      database.importDb({
        providerConnections: [],
        geminiWebSessions: [beforeSessions[0], beforeSessions[0]],
      })
    ).rejects.toThrow();
    expect(await repo.listGeminiWebSessions()).toEqual(beforeSessions);

    await expect(
      database.importDb({
        providerConnections: [
          {
            id: "dangling-connection",
            provider: "gemini-web",
            authType: "cookie",
            name: "Dangling",
            providerSpecificData: {
              geminiWebSessionId: "00000000-0000-4000-8000-000000000000",
              authUser: "0",
            },
          },
        ],
        geminiWebSessions: beforeSessions,
      })
    ).rejects.toThrow();
    expect(await repo.getGeminiWebSession(created.session.id)).toEqual(created.session);
    expect(await connections.getProviderConnectionById("dangling-connection")).toBeNull();
  });
});
