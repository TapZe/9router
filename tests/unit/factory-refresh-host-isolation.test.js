import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import * as crypto from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A local Droid CLI login lives in ~/.factory (and, on macOS, behind a
// Keychain key). WorkOS refresh tokens are single-use, so 9router owns the
// copy it imported: refreshing a connection must never read the Keychain,
// load the import route, or write the Droid CLI's credential store.
const home = mkdtempSync(join(tmpdir(), "9router-factory-refresh-"));
const originalHome = process.env.HOME;
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.DATA_DIR = home;

const hostAccess = vi.hoisted(() => ({ execFile: vi.fn(), execFileSync: vi.fn(), routeLoaded: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({ ...(await importOriginal()), execFile: hostAccess.execFile, execFileSync: hostAccess.execFileSync }));
vi.mock("child_process", async (importOriginal) => ({ ...(await importOriginal()), execFile: hostAccess.execFile, execFileSync: hostAccess.execFileSync }));
// Pass-through: records that the route module was loaded, keeps its behavior.
vi.mock("../../src/app/api/oauth/factory/auto-import/route.js", async (importOriginal) => {
  hostAccess.routeLoaded();
  return importOriginal();
});
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn() }));

const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
const { FactoryExecutor } = await import("../../open-sse/executors/factory.js");
const { loadDroidCliCredentials } = await import("../../src/lib/oauth/utils/factoryCredentials.js");

const json = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
const jwt = (claims) => `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

// The Droid CLI's file-backed store, with a newer session than 9router's copy.
const factoryDir = join(home, ".factory");
const storeFile = join(factoryDir, "auth.v2.file");
function writeDroidStore(payload) {
  mkdirSync(factoryDir, { recursive: true });
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
  writeFileSync(join(factoryDir, "auth.v2.key"), key.toString("base64"));
  writeFileSync(storeFile, `${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${data.toString("base64")}`);
}

const imported = (refreshToken) => ({
  accessToken: jwt({ exp: Math.floor(Date.now() / 1000) - 60 }),
  refreshToken,
  providerSpecificData: { orgId: "org_host_iso", isLocalCli: true },
});

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

describe("Factory refresh of a connection imported from the Droid CLI", () => {
  beforeEach(() => {
    proxyAwareFetch.mockReset();
    hostAccess.execFile.mockReset();
    hostAccess.execFileSync.mockReset();
    hostAccess.routeLoaded.mockReset();
    writeDroidStore({ access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }), refresh_token: "cli_newer_rt" });
  });

  it("stores the rotated tokens on the connection and leaves the Droid CLI store alone", async () => {
    const before = readFileSync(storeFile, "utf8");
    proxyAwareFetch.mockResolvedValue(json(200, { access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }), refresh_token: "rotated_rt" }));

    const refreshed = await new FactoryExecutor().refreshCredentials(imported("ok_rt"), null);

    expect(refreshed).toMatchObject({ refreshToken: "rotated_rt", providerSpecificData: { orgId: "org_host_iso" } });
    expect(readFileSync(storeFile, "utf8")).toBe(before);
    expect(hostAccess.execFile).not.toHaveBeenCalled();
    expect(hostAccess.execFileSync).not.toHaveBeenCalled();
    expect(hostAccess.routeLoaded).not.toHaveBeenCalled();
  });

  it("asks for re-import on invalid_grant instead of taking the Droid CLI's newer session", async () => {
    const before = readFileSync(storeFile, "utf8");
    proxyAwareFetch.mockResolvedValue(json(400, { error: "invalid_grant", error_description: "Refresh token already used" }));

    const refreshed = await new FactoryExecutor().refreshCredentials(imported("spent_rt"), null);

    expect(refreshed).toEqual({ error: "unrecoverable_refresh_error", code: "invalid_grant" });
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(readFileSync(storeFile, "utf8")).toBe(before);
    expect(hostAccess.execFile).not.toHaveBeenCalled();
    expect(hostAccess.execFileSync).not.toHaveBeenCalled();
    expect(hostAccess.routeLoaded).not.toHaveBeenCalled();
  });
});

// The explicit, local-only import action is the one place that reads the
// Droid CLI's login, Keychain included, and it does so without blocking.
describe("Factory import from the Droid CLI", () => {
  const originalPlatform = process.platform;

  it("reads a Keychain-backed login through async execFile", async () => {
    hostAccess.execFile.mockReset();
    hostAccess.execFileSync.mockReset();
    const key = crypto.randomBytes(32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify({ access_token: "kc_at", refresh_token: "kc_rt", active_organization_id: "org_kc" })), cipher.final()]);
    mkdirSync(factoryDir, { recursive: true });
    writeFileSync(join(factoryDir, "auth.v2.loginkeychain"), `${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${data.toString("base64")}`);
    hostAccess.execFile.mockImplementation((cmd, args, opts, cb) => cb(null, `${key.toString("base64")}\n`));
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      expect(await loadDroidCliCredentials()).toEqual({ accessToken: "kc_at", refreshToken: "kc_rt", activeOrganizationId: "org_kc" });
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
      rmSync(join(factoryDir, "auth.v2.loginkeychain"));
    }
    expect(hostAccess.execFile).toHaveBeenCalledWith("/usr/bin/security", ["find-generic-password", "-s", "Factory CLI", "-w"], expect.any(Object), expect.any(Function));
    expect(hostAccess.execFileSync).not.toHaveBeenCalled();
  });
});
