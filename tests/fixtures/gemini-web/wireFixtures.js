// Synthetic Gemini Web wire fixtures. Shapes mirror the reference project's
// *_test.go fixtures; no captured cookies or account data are used here.

export const GEMINI_XSSI = ")]}'\n";

export const SYNTHETIC_COOKIE =
  "__Secure-1PSID=synthetic-psid-value; __Secure-1PSIDTS=synthetic-psidts-value";
export const SYNTHETIC_AT = "synthetic-at-token";
export const SYNTHETIC_BUILD = "synthetic-build-label";
export const SYNTHETIC_GOOGLE_SESSION = "synthetic-google-session";
export const SYNTHETIC_GENERATION_ID = "11111111-2222-3333-4444-555555555555";

export function jsonFrame(value) {
  return JSON.stringify(value);
}

/** Render frames the way batchexecute does: XSSI guard + numeric length records. */
export function lengthPrefixedBody(values, { xssi = true, byteLengths = true } = {}) {
  const parts = [];
  if (xssi) parts.push(GEMINI_XSSI);
  for (const value of values) {
    const frame = typeof value === "string" ? value : JSON.stringify(value);
    const length = byteLengths ? Buffer.byteLength(frame) : frame.length;
    parts.push(`${length}\n${frame}\n`);
  }
  return parts.join("");
}

/** One wrb.fr record carrying a JSON-encoded payload at index 2. */
export function payloadFrame(payload, { rpcId = null, marker = "wrb.fr", metadata = undefined } = {}) {
  const item = [marker, rpcId, JSON.stringify(payload)];
  if (metadata !== undefined) item[3] = metadata;
  return [item];
}

export function modelEntry(modelId, category, display, number) {
  const entry = new Array(20);
  entry[0] = modelId;
  entry[1] = category;
  entry[11] = display;
  entry[17] = number === undefined ? null : number;
  return entry;
}

/**
 * GetUserStatus RPC fixture: status array at index 2 with account status,
 * entries, tiers and capabilities. `statusCode` may be null to omit the check.
 */
export function modelStatusFixture({
  statusCode = 1000,
  tiers = null,
  capabilities = null,
  entries = [],
} = {}) {
  const status = new Array(18);
  status[14] = statusCode;
  status[15] = entries;
  status[16] = tiers;
  status[17] = capabilities;
  return [[["wrb.fr", "otAQ7b", JSON.stringify(status), null, null, null, "generic"]]];
}

export function modelDiscoveryBody(options = {}) {
  return lengthPrefixedBody([modelStatusFixture(options)]);
}

export function answerPayload(text, { conversationId = "c_conversation", choiceId = "c_choice" } = {}) {
  return [null, conversationId, null, null, [[choiceId, [text]]]];
}

export function answerFrame(text, options = {}) {
  return payloadFrame(answerPayload(text, options));
}

/** Modern numbered-field reply shape: payload[2]["7"][0]. */
export function modernTextPayload(text, { conversationId = "c_conversation" } = {}) {
  return [null, [conversationId, "r_response"], { 7: [text] }];
}

/** Thinking status label at payload[2]["7"][5][0], with an empty reply slot. */
export function labelPayload(label, { conversationId = "c_conversation" } = {}) {
  return [
    null,
    [conversationId, "r_response"],
    { 7: [null, null, null, null, null, [label]], 44: true },
  ];
}

export function labelFrame(label, options = {}) {
  return payloadFrame(labelPayload(label, options));
}

/** Generated-image metadata lives only at candidate[12][7][0][i][0][3]. */
export function imagePayload({
  url,
  text = "",
  mime = "image/png",
  filename = "generated.png",
  width = 1024,
  height = 768,
} = {}) {
  const metadata = [null, 1, filename, url, null, mime, [width, height, 12345]];
  const imageEntry = [[null, null, null, metadata]];
  const slot = new Array(8);
  // groups[0] is the generated-image list; each item is the [wrapper] entry.
  slot[7] = [[imageEntry]];
  const candidate = new Array(13);
  candidate[0] = "c_choice";
  candidate[1] = [text];
  candidate[12] = slot;
  return [null, "c_conversation", null, null, [candidate]];
}

export function imageFrame(options = {}) {
  return payloadFrame(imagePayload(options));
}

export function usagePayload(text, usage, options = {}) {
  const payload = answerPayload(text, options);
  payload[5] = { usageMetadata: usage };
  return payload;
}

export function usageFrame(text, usage, options = {}) {
  return payloadFrame(usagePayload(text, usage, options));
}

export const BARD_ERROR_FIXTURE = `)]}'

[["wrb.fr",null,null,null,null,[13,null,[["type.googleapis.com/assistant.boq.bard.application.BardErrorInfo",[1152]]]]],["di",2461]]`;

export const BOOTSTRAP_HTML = `<html><head><script>window.WIZ_global_data = {"SNlM0e":"${SYNTHETIC_AT}","qKIAYe":"feeds/synthetic-push","cfb2h":"${SYNTHETIC_BUILD}","FdrFJe":"${SYNTHETIC_GOOGLE_SESSION}","TuX5cc":"vi"};</script></head><body>signed in</body></html>`;

export const BOOTSTRAP_HTML_FALLBACK_ARRAY = `<html><script>AF_initDataCallback([["SNlM0e","${SYNTHETIC_AT}"]]);</script></html>`;

export const SIGN_IN_HTML = `<html><body>Sign in to continue</body></html>`;

/** Split a string (or UTF-8 bytes) into fixed-size chunks so framing is tested byte by byte. */
export function splitText(text, sizes = [1]) {
  const bytes = new TextEncoder().encode(text);
  const chunks = [];
  let index = 0;
  let sizeIndex = 0;
  while (index < bytes.length) {
    const size = sizes[sizeIndex % sizes.length];
    chunks.push(bytes.slice(index, index + size));
    index += size;
    sizeIndex += 1;
  }
  return chunks;
}

export function streamFromChunks(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

export function streamFromText(text, sizes = [1]) {
  return streamFromChunks(splitText(text, sizes));
}
