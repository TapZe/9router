import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// DATA_DIR must be set before webLogin.js resolves getWritableDataDir so the
// fake browser profile never touches the developer's real profile store.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-web-login-"));
process.env.DATA_DIR = dataDir;

const {
  startWebLogin,
  captureWebLogin,
  beginWebLoginSave,
  cancelWebLogin,
  getWebLoginStatus,
  getPublicWebLoginStatus,
  __setWebLoginRuntimeForTests,
  __resetWebLoginSessionsForTests,
} = await import("../../open-sse/services/webLogin.js");

const PROVIDER = "gemini-web";
const TERMINAL = new Set(["success", "error", "timeout", "cancelled"]);

const GOOGLE_COOKIES = [
  { name: "__Secure-1PSID", value: "psid-live-0001", domain: ".google.com" },
  { name: "__Secure-1PSIDTS", value: "psidts-live-0001", domain: ".google.com" },
  { name: "NID", value: "nid-live-0001", domain: ".google.com" },
  { name: "SID", value: "sid-live-0001", domain: ".google.com" },
  { name: "AEC", value: "aec-live-0001", domain: ".google.com" },
  { name: "unrelated", value: "not-a-google-cookie", domain: ".example.com" },
];

const FULL_HEADER =
  "__Secure-1PSID=psid-live-0001; __Secure-1PSIDTS=psidts-live-0001; AEC=aec-live-0001; NID=nid-live-0001; SID=sid-live-0001";

function makePage(url) {
  let current = url;
  return {
    url: () => current,
    setUrl: (next) => { current = next; },
    goto: async () => {},
    waitForTimeout: async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
    },
    evaluate: async () => ({}),
  };
}

function makeContext({ pages = [], cookies = GOOGLE_COOKIES } = {}) {
  const context = {
    closed: false,
    cookies: async () => cookies,
    pages: () => pages,
    newPage: async () => {
      const page = makePage("about:blank");
      pages.push(page);
      return page;
    },
    close: async () => { context.closed = true; },
  };
  return context;
}

const clock = { now: 1_700_000_000_000 };

function installRuntime(context) {
  __setWebLoginRuntimeForTests({
    now: () => clock.now,
    pollIntervalMs: 1,
    loadPlaywright: async () => ({ chromium: {} }),
    executablePath: "/fake/chrome",
    launchContext: async () => context,
  });
  return context;
}

async function waitFor(predicate, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for condition");
}

async function startAndWait(context, options = {}) {
  installRuntime(context);
  const session = await startWebLogin(PROVIDER, options.profile || "default", options);
  await waitFor(() => getWebLoginStatus(PROVIDER)?.context);
  return session;
}

function publicStatus() {
  return getPublicWebLoginStatus(PROVIDER);
}

beforeEach(() => {
  clock.now = 1_700_000_000_000;
  __resetWebLoginSessionsForTests?.();
});

afterEach(async () => {
  cancelWebLogin(PROVIDER);
  __resetWebLoginSessionsForTests?.();
  __setWebLoginRuntimeForTests?.(null);
});

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("Gemini web login capture", () => {
  it("rejects a second Gemini start while one is running or captured", async () => {
    const context = makeContext({ pages: [makePage("https://gemini.google.com/app")] });
    await startAndWait(context, {
      profile: "work",
      name: "Shared Google session",
      geminiWebSessionId: "session-alpha",
      expectedRevision: 3,
      authUsers: ["2"],
    });

    await expect(
      startWebLogin(PROVIDER, "other", { authUsers: ["9"] })
    ).rejects.toMatchObject({ status: 409, code: "WEB_LOGIN_SESSION_ACTIVE" });

    const current = getWebLoginStatus(PROVIDER);
    expect(current.profile).toBe("work");
    expect(current.name).toBe("Shared Google session");
    expect(current.geminiWebSessionId).toBe("session-alpha");
    expect(current.expectedRevision).toBe(3);
    expect(current.authUsers).toEqual(["2"]);

    const captured = await captureWebLogin(PROVIDER);
    expect(captured.status).toBe("captured");

    await expect(startWebLogin(PROVIDER, "third")).rejects.toMatchObject({ status: 409 });
  });

  it("serializes the full .google.com jar, not only the required tokens", async () => {
    const context = makeContext({ pages: [makePage("https://gemini.google.com/app")] });
    await startAndWait(context);

    const status = await captureWebLogin(PROVIDER);
    expect(status.capturedAuthUser).toBe("");

    const session = getWebLoginStatus(PROVIDER);
    expect(session.credential).toBe(FULL_HEADER);
    expect(session.credential).not.toContain("not-a-google-cookie");
  });

  it("derives the slot from /u/N/, then authuser, otherwise root", async () => {
    const cases = [
      ["https://gemini.google.com/u/2/app", "2"],
      ["https://gemini.google.com/app?authuser=0", "0"],
      ["https://gemini.google.com/u/0/app?authuser=0", "0"],
      ["https://gemini.google.com/app", ""],
    ];

    for (const [url, expectedSlot] of cases) {
      const context = makeContext({ pages: [makePage(url)] });
      await startAndWait(context);
      const status = await captureWebLogin(PROVIDER);
      expect(status.capturedAuthUser).toBe(expectedSlot);
      cancelWebLogin(PROVIDER);
      await waitFor(() => TERMINAL.has(getWebLoginStatus(PROVIDER)?.status));
      __resetWebLoginSessionsForTests();
    }
  });

  it("rejects a page whose URL and authuser query disagree", async () => {
    const context = makeContext({ pages: [makePage("https://gemini.google.com/u/2/app?authuser=3")] });
    await startAndWait(context);

    await expect(captureWebLogin(PROVIDER)).rejects.toMatchObject({
      code: "WEB_LOGIN_SLOT_CONFLICT",
    });
    expect(getWebLoginStatus(PROVIDER).status).toBe("running");
    expect(getWebLoginStatus(PROVIDER).credential).toBeUndefined();
  });

  it("requires pageId when several signed-in Gemini tabs are open", async () => {
    const pages = [
      makePage("https://gemini.google.com/u/0/app"),
      makePage("https://gemini.google.com/u/2/app"),
    ];
    const context = makeContext({ pages });
    await startAndWait(context);

    const running = publicStatus();
    expect(running.pages.map((entry) => entry.slot)).toEqual(["0", "2"]);
    expect(running.pages.every((entry) => Object.keys(entry).sort().join(",") === "id,slot")).toBe(true);

    await expect(captureWebLogin(PROVIDER)).rejects.toMatchObject({
      code: "WEB_LOGIN_PAGE_REQUIRED",
    });

    const target = running.pages.find((entry) => entry.slot === "2");
    const status = await captureWebLogin(PROVIDER, { pageId: target.id });
    expect(status.capturedAuthUser).toBe("2");

    // Page ids stay stable across polls and never carry the page URL.
    const after = publicStatus();
    expect(after.pages).toEqual(running.pages);
    expect(JSON.stringify(after)).not.toContain("gemini.google.com");
  });

  it("ignores non-Gemini tabs and rejects capture when none are eligible", async () => {
    const context = makeContext({
      pages: [makePage("https://accounts.google.com/signin")],
    });
    await startAndWait(context);

    await expect(captureWebLogin(PROVIDER)).rejects.toMatchObject({
      code: "WEB_LOGIN_PAGE_UNAVAILABLE",
    });
  });

  it("validates capture slot options before touching state", async () => {
    const context = makeContext({ pages: [makePage("https://gemini.google.com/u/2/app")] });
    await startAndWait(context);

    await expect(
      captureWebLogin(PROVIDER, { authUsers: ["-1"] })
    ).rejects.toMatchObject({ code: "WEB_LOGIN_SLOT_INVALID" });
    await expect(
      captureWebLogin(PROVIDER, { authUsers: ["2.5"] })
    ).rejects.toMatchObject({ code: "WEB_LOGIN_SLOT_INVALID" });
    await expect(
      captureWebLogin(PROVIDER, { pageId: "page-999" })
    ).rejects.toMatchObject({ code: "WEB_LOGIN_PAGE_UNKNOWN" });

    expect(getWebLoginStatus(PROVIDER).status).toBe("running");
  });

  it("never exposes cookies or page URLs in the public status", async () => {
    const context = makeContext({ pages: [makePage("https://gemini.google.com/u/2/app")] });
    await startAndWait(context);
    await captureWebLogin(PROVIDER);

    const status = publicStatus();
    expect(Object.keys(status).sort()).toEqual([
      "capturedAuthUser",
      "connectionIds",
      "error",
      "pages",
      "profile",
      "provider",
      "sessionId",
      "status",
    ]);
    expect(status.capturedAuthUser).toBe("2");

    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain("psid");
    expect(serialized).not.toContain("Cookie");
    expect(serialized).not.toContain("credential");
    expect(serialized).not.toContain("gemini.google.com");
  });

  it("cancel during saving drops the capture and never calls commit", async () => {
    const context = makeContext({ pages: [makePage("https://gemini.google.com/u/2/app")] });
    await startAndWait(context);
    await captureWebLogin(PROVIDER);

    let commits = 0;
    const savePromise = beginWebLoginSave(PROVIDER, {
      commit: async () => {
        commits += 1;
        return { connectionIds: ["conn-1"], sessionId: "session-alpha" };
      },
    });

    expect(getWebLoginStatus(PROVIDER).status).toBe("saving");
    expect(cancelWebLogin(PROVIDER)).toBe(true);
    const result = await savePromise;

    expect(commits).toBe(0);
    expect(result.status).toBe("cancelled");
    expect(getWebLoginStatus(PROVIDER).credential).toBeUndefined();
    expect(publicStatus().capturedAuthUser).toBeNull();
    await waitFor(() => context.closed);
  });

  it("pauses the interactive window while a save is verifying", async () => {
    const context = makeContext({ pages: [makePage("https://gemini.google.com/u/2/app")] });
    await startAndWait(context);

    clock.now += 295000; // 4:55 into the interactive window
    await captureWebLogin(PROVIDER);

    let releaseCommit;
    const commitGate = new Promise((resolve) => { releaseCommit = resolve; });
    const savePromise = beginWebLoginSave(PROVIDER, {
      commit: async () => {
        await commitGate;
        return { connectionIds: ["conn-1"], sessionId: "session-alpha" };
      },
    });

    clock.now += 30000; // past the original five-minute deadline
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(getWebLoginStatus(PROVIDER).status).toBe("saving");

    releaseCommit();
    const result = await savePromise;
    expect(result.status).toBe("success");
    await waitFor(() => context.closed);
  });

  it("re-arms a fresh five-minute window after a failed verification", async () => {
    const context = makeContext({ pages: [makePage("https://gemini.google.com/u/2/app")] });
    await startAndWait(context);

    clock.now += 295000;
    await captureWebLogin(PROVIDER);

    const savePromise = beginWebLoginSave(PROVIDER, {
      commit: async () => {
        throw new Error("Google rejected the captured session");
      },
    });
    const result = await savePromise;

    expect(result.status).toBe("running");
    expect(result.error).toContain("Slot 2");
    expect(publicStatus().capturedAuthUser).toBeNull();
    expect(getWebLoginStatus(PROVIDER).credential).toBeUndefined();

    // Well past the original deadline, but the recapture window was re-armed.
    clock.now += 299000;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(getWebLoginStatus(PROVIDER).status).toBe("running");

    clock.now += 1001;
    await waitFor(() => getWebLoginStatus(PROVIDER).status === "timeout");
  });

  it("closes the browser only after the save is acknowledged", async () => {
    const context = makeContext({ pages: [makePage("https://gemini.google.com/u/2/app")] });
    await startAndWait(context);
    await captureWebLogin(PROVIDER);

    expect(context.closed).toBe(false);

    const saved = await beginWebLoginSave(PROVIDER, {
      commit: async () => ({ connectionIds: ["conn-1"], sessionId: "session-alpha" }),
    });

    expect(saved.status).toBe("success");
    expect(publicStatus()).toMatchObject({
      status: "success",
      sessionId: "session-alpha",
      connectionIds: ["conn-1"],
    });
    expect(publicStatus().capturedAuthUser).toBeNull();
    await waitFor(() => context.closed);
  });
});
