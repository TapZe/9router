export default {
  id: "gemini-web",
  priority: 220,
  alias: "gemini-web",
  aliases: [
    "gweb",
  ],
  uiAlias: "gemini-web",
  display: {
    name: "Gemini Web",
    icon: "auto_awesome",
    color: "#4285F4",
    textIcon: "GW",
    website: "https://gemini.google.com",
  },
  category: "webCookie",
  authType: "cookie",
  // Chat models are discovered per signed-in Google account, so the static
  // catalog carries only the stable image task; `/v1/models` publishes the
  // account catalogs from their verified snapshots.
  serviceKinds: ["llm", "image"],
  apiKeyOptionalWith: "geminiWebSessionId",
  authHint:
    "Paste the complete Cookie request header from gemini.google.com: DevTools → Network → reload → select batchexecute?rpcids=otAQ7b → Request Headers → Cookie. Use the account tab's /u/N/ slot.",
  transport: {
    baseUrl: "https://gemini.google.com/app",
    format: "openai",
    authType: "cookie",
  },
  // `supportsReasoning` is omitted deliberately: the account decides which
  // chat models exist, and effort is validated by the executor against the
  // three levels Gemini Web can encode.
  models: [
    { id: "gemini-image", name: "Gemini Image (web)", params: ["n", "size"], kind: "image" },
  ],
};
