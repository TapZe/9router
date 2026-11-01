import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { AUTO_PING_SETTINGS_KEYS, normalizePingSchedule } from "@/shared/services/quotaPingSchedule.js";
const DEFAULT_MITM_ROUTER_BASE = "http://localhost:20128";
const DEFAULT_HEADROOM_URL = process.env.HEADROOM_URL || "http://localhost:8787";

const DEFAULT_SETTINGS = {
  cloudEnabled: false,
  tunnelEnabled: false,
  tunnelUrl: "",
  tunnelProvider: "cloudflare",
  tailscaleEnabled: false,
  tailscaleUrl: "",
  stickyRoundRobinLimit: 3,
  providerStrategies: {},
  quotaVisibility: {},
  comboStrategy: "fallback",
  comboStickyRoundRobinLimit: 1,
  comboStrategies: {},
  capacityAdapter: {
    vision: { enabled: true, roundRobin: false, models: [] },
    pdf: { enabled: false, roundRobin: false, models: [] },
    audioInput: { enabled: true, roundRobin: false, models: [] },
    videoInput: { enabled: false, roundRobin: false, models: [] },
  },
  requireLogin: true,
  requireApiKey: true,
  tunnelDashboardAccess: true,
  authMode: "password",
  ssoType: "oidc",
  oidcIssuerUrl: "",
  oidcClientId: "",
  oidcClientSecret: "",
  oidcScopes: "openid profile email",
  oidcLoginLabel: "Sign in with OIDC",
  samlEntryPoint: "",
  samlIssuer: "urn:9router:sp",
  samlCert: "",
  samlLoginLabel: "Sign in with SAML SSO",
  samlAttributeEmail: "email",
  samlAttributeName: "name",
  enableObservability: false,
  observabilityMaxRecords: 1000,
  observabilityBatchSize: 20,
  observabilityFlushIntervalMs: 5000,
  observabilityMaxJsonSize: 5,
  outboundProxyEnabled: false,
  outboundProxyUrl: "",
  outboundNoProxy: "",
  mitmRouterBaseUrl: DEFAULT_MITM_ROUTER_BASE,
  dnsToolEnabled: {},
  rtkEnabled: true,
  headroomEnabled: false,
  headroomUrl: DEFAULT_HEADROOM_URL,
  headroomCompressUserMessages: false,
  headroomTimeoutMs: 3000,
  cavemanEnabled: false,
  cavemanLevel: "full",
  ponytailEnabled: false,
  ponytailLevel: "full",
  // User-authored system prompt, injected independently of the built-in savers.
  customPromptEnabled: false,
  customPrompt: "",
  pxpipeEnabled: false,
  pxpipeAutoInstall: true,
  pxpipeMinChars: 25000,
  pxpipeTimeoutMs: 15000,
  // Per-provider user header overrides applied at dispatch: { [providerId]: { headers: {..} } }
  providerOverrides: {},
};

async function readRaw() {
  const db = await getAdapter();
  const row = db.get(`SELECT data FROM settings WHERE id = 1`);
  return row ? parseJson(row.data, {}) : {};
}

// Merge raw settings with defaults; backward-compat for missing keys
export function mergeWithDefaults(raw) {
  const merged = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  for (const [key, defVal] of Object.entries(DEFAULT_SETTINGS)) {
    if (merged[key] === undefined) {
      if (
        key === "outboundProxyEnabled" &&
        typeof merged.outboundProxyUrl === "string" &&
        merged.outboundProxyUrl.trim()
      ) {
        merged[key] = true;
      } else {
        merged[key] = defVal;
      }
    }
  }
  if (merged.capacityAdapter && typeof merged.capacityAdapter === "object") {
    for (const capKey of Object.keys(merged.capacityAdapter)) {
      const entry = merged.capacityAdapter[capKey];
      if (Array.isArray(entry?.models)) {
        entry.models = entry.models.map((m) =>
          m === "oc/mimo-v2.5-free" ? "oc/mimo-v2.6-flash-free" : m
        );
      }
    }
  }
  return merged;
}

export async function getSettings() {
  const raw = await readRaw();
  return mergeWithDefaults(raw);
}

// Atomic read-merge-write inside transaction (prevents losing concurrent updates)
export async function updateSettings(updates) {
  const db = await getAdapter();
  let next;
  db.transaction(function () {
    const row = db.get(`SELECT data FROM settings WHERE id = 1`);
    const current = row ? parseJson(row.data, {}) : {};
    next = { ...current, ...updates };
    db.run(
      `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      [stringifyJson(next)],
    );
  });
  return mergeWithDefaults(next);
}

export async function isCloudEnabled() {
  const settings = await getSettings();
  return settings.cloudEnabled === true;
}

export async function getCloudUrl() {
  const settings = await getSettings();
  return (
    settings.cloudUrl ||
    process.env.CLOUD_URL ||
    process.env.NEXT_PUBLIC_CLOUD_URL ||
    ""
  );
}

export async function exportSettings() {
  return await readRaw();
}

export async function updateAccountAutoPing({ provider, connectionId, reactive, schedule }) {
  if (!provider || typeof provider !== "string" || !Object.hasOwn(AUTO_PING_SETTINGS_KEYS, provider)) {
    const err = new Error(`Unsupported auto-ping provider: ${provider}`);
    err.code = "INVALID_PROVIDER";
    throw err;
  }
  const settingsKey = AUTO_PING_SETTINGS_KEYS[provider];

  if (!connectionId || typeof connectionId !== "string" || !connectionId.trim()) {
    const err = new Error("connectionId is required and must be a non-empty string");
    err.code = "INVALID_CONNECTION_ID";
    throw err;
  }
  if (typeof reactive !== "boolean") {
    const err = new Error("reactive must be a boolean");
    err.code = "INVALID_REACTIVE";
    throw err;
  }
  let normalizedSchedule = null;
  if (schedule !== null && schedule !== undefined) {
    if (typeof schedule !== "object" || Array.isArray(schedule)) {
      const err = new Error("schedule must be an object or null");
      err.code = "INVALID_SCHEDULE";
      throw err;
    }
    if (schedule.enabled === true) {
      normalizedSchedule = normalizePingSchedule(schedule);
    }
  }

  const db = await getAdapter();
  let updatedProviderConfig;
  let fullSettings;

  db.transaction(function () {
    const connRow = db.get(
      `SELECT id, provider, authType FROM providerConnections WHERE id = ?`,
      [connectionId],
    );
    if (!connRow) {
      const err = new Error(`Connection not found: ${connectionId}`);
      err.code = "NOT_FOUND";
      throw err;
    }
    if (connRow.provider !== provider) {
      const err = new Error(
        `Connection provider mismatch: connection ${connectionId} is for "${connRow.provider}", requested "${provider}"`,
      );
      err.code = "PROVIDER_MISMATCH";
      throw err;
    }
    if (connRow.authType !== "oauth") {
      const err = new Error(
        `Connection authType mismatch: connection ${connectionId} has authType "${connRow.authType}", expected "oauth"`,
      );
      err.code = "AUTHTYPE_MISMATCH";
      throw err;
    }

    const row = db.get(`SELECT data FROM settings WHERE id = 1`);
    const currentSettings = row ? parseJson(row.data, {}) : {};
    const currentProviderConfig =
      currentSettings[settingsKey] && typeof currentSettings[settingsKey] === "object"
        ? currentSettings[settingsKey]
        : {};

    updatedProviderConfig = {
      ...currentProviderConfig,
      connections: {
        ...(currentProviderConfig.connections || {}),
        [connectionId]: reactive,
      },
      schedules: {
        ...(currentProviderConfig.schedules || {}),
        [connectionId]: normalizedSchedule,
      },
    };

    const nextSettings = {
      ...currentSettings,
      [settingsKey]: updatedProviderConfig,
    };

    db.run(
      `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      [stringifyJson(nextSettings)],
    );

    fullSettings = mergeWithDefaults(nextSettings);
  });

  return { config: updatedProviderConfig, settings: fullSettings };
}
