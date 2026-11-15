// Disposable database fixture for the Gemini Web account/session suites.
//
// src/lib/dataDir.js captures DATA_DIR at first import and the adapter lives on
// global._dbAdapter, so resetting Vitest's module registry alone is not enough:
// the stale singleton must be cleared as well. The fixture refuses to reuse an
// adapter it did not create — flushing an unknown adapter could destroy a real
// database — and proves DATA_FILE resolves beneath its own temporary root
// before any test writes to it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "DATA_DIR",
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
];

function isInside(root, file) {
  const prefix = path.resolve(root) + path.sep;
  return path.resolve(file).startsWith(prefix);
}

function restoreEnv(previousEnv) {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function removeRoot(root) {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}

export async function setupGeminiWebDb() {
  const previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "9router-gemini-web-")));
  const preexisting = global._dbAdapter;
  if (preexisting?.instance || preexisting?.initPromise) {
    removeRoot(root);
    throw new Error(
      "geminiWebDb: refusing to reuse a database adapter created outside this fixture"
    );
  }

  process.env.HOME = root;
  process.env.USERPROFILE = root;
  process.env.DATA_DIR = root;
  process.env.XDG_DATA_HOME = path.join(root, "xdg", "data");
  process.env.XDG_CONFIG_HOME = path.join(root, "xdg", "config");
  process.env.XDG_CACHE_HOME = path.join(root, "xdg", "cache");

  const { vi } = await import("vitest");
  vi.resetModules();
  delete global._dbAdapter;

  let adapter = null;
  try {
    const paths = await import("../../src/lib/db/paths.js");
    const dataFile = path.resolve(paths.DATA_FILE);
    if (!isInside(root, dataFile)) {
      throw new Error(`geminiWebDb: DATA_FILE ${dataFile} escapes fixture root ${root}`);
    }

    const { getAdapter } = await import("../../src/lib/db/driver.js");
    adapter = await getAdapter();
    if (!fs.existsSync(dataFile)) {
      throw new Error(`geminiWebDb: expected database file ${dataFile} was not created`);
    }
    if (global._dbAdapter?.instance !== adapter) {
      throw new Error("geminiWebDb: fixture adapter is not the active database singleton");
    }

    return {
      root,
      dataFile,
      adapter,
      clear() {
        adapter.transaction(() => {
          adapter.run("DELETE FROM providerConnections");
          adapter.run("DELETE FROM kv");
        });
      },
      teardown() {
        const foreign = global._dbAdapter?.instance;
        if (!foreign || foreign === adapter) delete global._dbAdapter;
        try {
          adapter.close?.();
        } catch {
          // A failed init may already have closed the handle; temp removal still applies.
        }
        restoreEnv(previousEnv);
        removeRoot(root);
        if (foreign && foreign !== adapter) {
          throw new Error(
            "geminiWebDb: refusing to close a database adapter created outside this fixture"
          );
        }
      },
    };
  } catch (error) {
    try {
      adapter?.close?.();
    } catch {
      // Adapter may have failed before opening; cleanup below still runs.
    }
    const foreign = global._dbAdapter?.instance;
    if (!foreign || foreign === adapter) delete global._dbAdapter;
    restoreEnv(previousEnv);
    removeRoot(root);
    throw error;
  }
}
