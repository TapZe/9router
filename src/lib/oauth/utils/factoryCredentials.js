// Reads the local Factory Droid CLI login so the explicit, local-only
// /api/oauth/factory/auto-import action can copy it into a 9router connection.
//
// Only that import action may call this. WorkOS refresh tokens are single-use,
// so after the copy 9router owns its tokens: the refresh path never reads the
// Keychain or ~/.factory and never writes Droid's store (Droid commits its own
// rotations with a compare-and-swap that an outside writer would bypass).
import { execFile } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const FACTORY_DIR = path.join(os.homedir(), ".factory");
const LOGIN_KEYCHAIN_PATH = path.join(FACTORY_DIR, "auth.v2.loginkeychain");
const FILE_STORAGE_PATH = path.join(FACTORY_DIR, "auth.v2.file");
const KEYFILE_PATH = path.join(FACTORY_DIR, "auth.v2.key");

const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

export function decryptPayload(ciphertext, key) {
  if (!ciphertext || typeof ciphertext !== "string" || !key) return null;
  const parts = ciphertext.trim().split(":");
  if (parts.length !== 3) return null;

  const iv = Buffer.from(parts[0], "base64");
  const authTag = Buffer.from(parts[1], "base64");
  const encryptedData = Buffer.from(parts[2], "base64");

  if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH) {
    return null;
  }

  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
    const parsed = JSON.parse(decrypted.toString("utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

// Async so a Keychain prompt or a slow `security` call never blocks the event loop.
export async function readKeychainKey() {
  // No Keychain lookup or macOS password prompt without ciphertext to decrypt.
  if (process.platform !== "darwin" || !fs.existsSync(LOGIN_KEYCHAIN_PATH)) return null;
  try {
    const stdout = await new Promise((resolve, reject) => {
      execFile(
        "/usr/bin/security",
        ["find-generic-password", "-s", "Factory CLI", "-w"],
        { encoding: "utf8", timeout: 5000 },
        (error, out) => (error ? reject(error) : resolve(out)),
      );
    });
    const key = String(stdout).trim();
    if (key.length > 0) return Buffer.from(key, "base64");
  } catch {
    // Keychain item unavailable or access denied
  }
  return null;
}

export function readKeyfileKey() {
  try {
    if (fs.existsSync(KEYFILE_PATH)) {
      const raw = fs.readFileSync(KEYFILE_PATH, "utf8").trim();
      if (raw.length > 0) {
        return Buffer.from(raw, "base64");
      }
    }
  } catch {
    // Keyfile unreadable
  }
  return null;
}

// One encrypted store file → the session it holds, or null.
function readStore(file, key) {
  if (!key || !fs.existsSync(file)) return null;
  try {
    const decrypted = decryptPayload(fs.readFileSync(file, "utf8"), key);
    if (decrypted && typeof decrypted.access_token === "string" && typeof decrypted.refresh_token === "string") {
      return {
        accessToken: decrypted.access_token,
        refreshToken: decrypted.refresh_token,
        activeOrganizationId: decrypted.active_organization_id || undefined,
      };
    }
  } catch {
    // Unreadable store
  }
  return null;
}

export async function loadDroidCliCredentials() {
  // 1. macOS Keychain key + auth.v2.loginkeychain
  const fromKeychain = readStore(LOGIN_KEYCHAIN_PATH, await readKeychainKey());
  if (fromKeychain) return fromKeychain;

  // 2. File-backed key (auth.v2.key) + auth.v2.file or auth.v2.loginkeychain
  const fileKey = readKeyfileKey();
  return readStore(FILE_STORAGE_PATH, fileKey) || readStore(LOGIN_KEYCHAIN_PATH, fileKey);
}
