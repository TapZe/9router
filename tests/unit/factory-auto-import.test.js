import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import * as crypto from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalHome = process.env.HOME;
const originalDataDir = process.env.DATA_DIR;
const testDir = mkdtempSync(join(tmpdir(), "9router-factory-autoimport-"));
process.env.HOME = testDir;
process.env.DATA_DIR = testDir;
const { DATA_FILE } = await import("../../src/lib/db/paths.js");
if (DATA_FILE !== join(testDir, "db", "data.sqlite") || global._dbAdapter?.instance || global._dbAdapter?.initPromise) {
  throw new Error("Factory auto-import tests require a fresh disposable database");
}

const { decryptPayload, encryptPayload, saveDroidCliCredentials, readKeyfileKey,
  readKeychainKey, loadDroidCliCredentials, GET, POST } = await import("../../src/app/api/oauth/factory/auto-import/route.js");
const { default: factoryProvider } = await import("../../src/lib/oauth/providers/factory.js");

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  rmSync(testDir, { recursive: true, force: true });
});

describe("Factory Droid Local Auto-Import", () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
    vi.restoreAllMocks();
  });

  describe("decryptPayload and encryptPayload", () => {
    const key = crypto.randomBytes(32);

    it("encrypts and decrypts valid AES-256-GCM ciphertext roundtrip", () => {
      const payload = {
        access_token: "test_access_token_123",
        refresh_token: "test_refresh_token_456",
        active_organization_id: "RFmWaCAuH8jTGM21tL5k",
      };

      const ciphertext = encryptPayload(payload, key);
      expect(typeof ciphertext).toBe("string");
      const decrypted = decryptPayload(ciphertext, key);

      expect(decrypted).toEqual(payload);
    });

    it("returns null for malformed ciphertext", () => {
      expect(decryptPayload("invalid:ciphertext", key)).toBeNull();
      expect(decryptPayload("", key)).toBeNull();
      expect(decryptPayload(null, key)).toBeNull();
    });

    it("returns null when auth tag is tampered or key is wrong", () => {
      const payload = { access_token: "tok" };
      const ciphertext = encryptPayload(payload, key);
      const parts = ciphertext.split(":");
      const tamperedTag = Buffer.from(parts[1], "base64");
      tamperedTag[0] ^= 1; // flip 1 bit
      const tamperedCiphertext = `${parts[0]}:${tamperedTag.toString("base64")}:${parts[2]}`;

      expect(decryptPayload(tamperedCiphertext, key)).toBeNull();

      const wrongKey = crypto.randomBytes(32);
      expect(decryptPayload(ciphertext, wrongKey)).toBeNull();
    });
  });

  describe("loadDroidCliCredentials and saveDroidCliCredentials", () => {
    it("does not read Keychain without a local encrypted credential file", () => {
      expect(readKeychainKey()).toBeNull();
    });

    it("returns null when no credentials exist in candidate paths", () => {
      const creds = loadDroidCliCredentials();
      expect(creds).toBeNull();
    });

    it("handles saveDroidCliCredentials validation safely", () => {
      expect(saveDroidCliCredentials(null)).toBe(false);
      expect(saveDroidCliCredentials({})).toBe(false);
      expect(saveDroidCliCredentials({ accessToken: "only_access" })).toBe(false);
      expect(saveDroidCliCredentials({ refreshToken: "only_refresh" })).toBe(false);
    });
  });

  describe("GET and POST Route Handlers", () => {
    it("handles GET request safely without throwing uncaught errors", async () => {
      const response = await GET();
      expect(response).toBeDefined();
      const json = await response.json();
      expect(json.found).toBe(false);
    });

    it("handles POST request safely and returns JSON", async () => {
      const response = await POST();
      expect(response.status).toBe(404);
    });

    it("imports an encrypted fixture from disposable HOME into disposable DB", async () => {
      const factoryDir = join(testDir, ".factory");
      mkdirSync(factoryDir, { recursive: true, mode: 0o700 });
      const key = crypto.randomBytes(32);
      const keyfile = join(factoryDir, "auth.v2.key");
      const encryptedFile = join(factoryDir, "auth.v2.file");
      writeFileSync(keyfile, key.toString("base64"), { mode: 0o600 });
      writeFileSync(encryptedFile, encryptPayload({
        access_token: "fixture_access_token",
        refresh_token: "fixture_refresh_token",
        active_organization_id: "org_fixture",
      }, key), { mode: 0o600 });
      const lookup = vi.spyOn(factoryProvider, "postExchange").mockResolvedValue({
        orgId: "org_fixture",
        whoami: { user: { email: "fixture@example.test", name: "Fixture Account" } },
      });
      try {
        expect(readKeychainKey()).toBeNull();
        expect((await GET().then((r) => r.json()))).toMatchObject({ found: true, email: "fixture@example.test", orgId: "org_fixture" });
        const response = await POST();
        expect(response.status).toBe(200);
        const { connection } = await response.json();
        const { getProviderConnections } = await import("../../src/models");
        const saved = (await getProviderConnections()).find((entry) => entry.id === connection.id);
        expect(saved).toMatchObject({
          provider: "factory",
          email: "fixture@example.test",
          providerSpecificData: { orgId: "org_fixture", isLocalCli: true },
        });
        expect(lookup).toHaveBeenCalledTimes(2);
      } finally {
        lookup.mockRestore();
        unlinkSync(keyfile);
        unlinkSync(encryptedFile);
      }
    });
  });

  describe("Factory Connection Organization Deduplication & Isolation", () => {
    it("creates distinct connections for different orgIds under the same email", async () => {
      const { createProviderConnection, getProviderConnections, deleteProviderConnection } = await import("../../src/models");
      const testEmail = `factory_test_${Date.now()}@example.com`;

      const conn1 = await createProviderConnection({
        provider: "factory",
        authType: "oauth",
        email: testEmail,
        accessToken: "tok_org1",
        providerSpecificData: { orgId: "org_alpha" },
      });

      const conn2 = await createProviderConnection({
        provider: "factory",
        authType: "oauth",
        email: testEmail,
        accessToken: "tok_org2",
        providerSpecificData: { orgId: "org_beta" },
      });

      expect(conn1.id).not.toBe(conn2.id);
      expect(conn1.name).toContain("org_alpha");
      expect(conn2.name).toContain("org_beta");

      // Re-authenticating org_alpha should update conn1 rather than create a new one
      const conn1Updated = await createProviderConnection({
        provider: "factory",
        authType: "oauth",
        email: testEmail,
        accessToken: "tok_org1_refreshed",
        providerSpecificData: { orgId: "org_alpha" },
      });

      expect(conn1Updated.id).toBe(conn1.id);

      // Cleanup
      await deleteProviderConnection(conn1.id);
      await deleteProviderConnection(conn2.id);
    });
  });
});

