import { describe, expect, it } from "vitest";
import {
  GEMINI_WEB_TASK,
  GEMINI_WEB_TRANSPORT,
  selectGeminiTransport,
} from "../../open-sse/executors/gemini-web/models.js";

const { PROCESS_SESSION, STREAM_GENERATE } = GEMINI_WEB_TRANSPORT;
const { CHAT, IMAGE } = GEMINI_WEB_TASK;

// Any resolved account model: the lane never depends on the upstream hex id,
// because the hex id is fetched per account and changes whenever Google
// republishes its catalog.
const chatModel = { id: "gemini-synthetic", modelId: "synthetic-hex-id", modelNumber: 1 };
const policyModel = { ...chatModel, policy: true };
const attached = [{ id: "synthetic-upload", name: "diagram.png" }];

describe("Gemini Web transport selection", () => {
  it("carries text-only chat on the channel surface without knowing the model id", () => {
    expect(selectGeminiTransport({ model: chatModel })).toBe(PROCESS_SESSION);
    expect(selectGeminiTransport({ model: { ...chatModel, modelId: "another-hex-id" } }))
      .toBe(PROCESS_SESSION);
  });

  it("keeps the media surfaces on StreamGenerate even for a policy code", () => {
    expect(selectGeminiTransport({ model: chatModel, files: attached })).toBe(STREAM_GENERATE);
    expect(selectGeminiTransport({ model: chatModel, task: IMAGE })).toBe(STREAM_GENERATE);
    expect(selectGeminiTransport({ model: policyModel, task: IMAGE })).toBe(STREAM_GENERATE);
  });

  it("keeps a policy code on the channel surface it is published for", () => {
    expect(selectGeminiTransport({ model: policyModel })).toBe(PROCESS_SESSION);
    expect(selectGeminiTransport({ model: policyModel, channelIdentity: false }))
      .toBe(PROCESS_SESSION);
  });

  it("falls back to StreamGenerate for an ordinary model without channel identity", () => {
    expect(selectGeminiTransport({ model: chatModel, channelIdentity: false }))
      .toBe(STREAM_GENERATE);
  });

  it("treats a non-array attachment list and an unknown task as media-only", () => {
    expect(selectGeminiTransport({ model: chatModel, files: null })).toBe(STREAM_GENERATE);
    expect(selectGeminiTransport({ model: chatModel, files: "not-a-list" })).toBe(STREAM_GENERATE);
    expect(selectGeminiTransport({ model: chatModel, task: "embedding" })).toBe(STREAM_GENERATE);
  });

  it("defaults to chat on the named task when the caller omits it", () => {
    expect(selectGeminiTransport({ model: chatModel, task: CHAT })).toBe(PROCESS_SESSION);
    expect(selectGeminiTransport({ model: chatModel, task: undefined })).toBe(PROCESS_SESSION);
  });
});
