// Argon BrowserChannel lifecycle: the receive poll is armed before the turn is
// posted, and a poll that closes without the completed turn is a rollover the
// same turn rearms instead of a second generation.

import { describe, expect, it, vi } from "vitest";

import { GEMINI_WEB_LIMITS } from "../../open-sse/executors/gemini-web/config.js";
import { generateGeminiWeb } from "../../open-sse/executors/gemini-web/protocol.js";
import { streamBodyFromAnswerText } from "../../open-sse/executors/gemini-web/processSession.js";
import { decodeGeminiWebStream } from "../../open-sse/executors/gemini-web/stream.js";
import { isNonReplayableResponse } from "../../open-sse/utils/replayPolicy.js";
import { SYNTHETIC_COOKIE, SYNTHETIC_AT, SYNTHETIC_API_KEY } from "../fixtures/gemini-web/wireFixtures.js";
import {
  ARGON_BIND_FINAL_TEXT,
  ARGON_BIND_RECORDS,
  argonBindBody,
} from "../fixtures/gemini-web/argonBindFixtures.js";

const session = {
  cookieHeader: SYNTHETIC_COOKIE,
  at: SYNTHETIC_AT,
  language: "en",
  apiConsumerKey: SYNTHETIC_API_KEY,
};
const model = {
  id: "gemini-code-analysis",
  modelId: "argon",
  modelNumber: 8,
  capacity: 2,
  capacityField: 12,
  policy: true,
};

const bindRecord = (kind) => ARGON_BIND_RECORDS.find((item) => item.kind === kind);
const completedBody = () => argonBindBody([bindRecord("final-answer")]);
const partialBody = () => argonBindBody([bindRecord("partial-answer")]);
const heartbeatBody = '14\n[[1,["noop"]]]\n';
const openReply = () =>
  new Response('[[0,["c","synthetic-channel","0",8]]]', {
    headers: { "x-http-session-id": "synthetic-session" },
  });

function isOpen(options) {
  return String(options.body || "").startsWith("count=0");
}

/**
 * A response body that never produces data on its own: the real transport
 * destroys the body when the request signal aborts, so this stand-in errors the
 * stream the same way and proves which layer owns the classification.
 */
function stallingBody(signal) {
  return new ReadableStream({
    start(controller) {
      signal?.addEventListener(
        "abort",
        () => {
          const error = new Error("Gemini Web transport request failed");
          error.name = "AbortError";
          controller.error(error);
        },
        { once: true }
      );
    },
  });
}

function aidOf(url) {
  return new URL(url).searchParams.get("AID");
}

async function answerOf(response) {
  let answer = "";
  for await (const event of decodeGeminiWebStream(response.body)) {
    if (event.type === "text") answer = event.text;
  }
  return answer;
}

function run(options) {
  return generateGeminiWeb({ session, model, prompt: "hello", thinkingLevel: "low", ...options });
}

describe("Argon BrowserChannel lifecycle", () => {
  it("arms the receive channel before posting a turn", async () => {
    const order = [];
    let listening = false;
    const transport = async (_url, options) => {
      if (options.method === "GET") {
        listening = true;
        order.push("receive");
        return new Response(completedBody());
      }
      if (isOpen(options)) return openReply();
      order.push("send");
      if (!listening) return new Response("receive channel not armed", { status: 409 });
      return new Response("[[0,0,0]]");
    };

    const response = await run({ transport });

    expect(response.status).toBe(200);
    expect(await answerOf(response)).toBe(ARGON_BIND_FINAL_TEXT);
    expect(order).toEqual(["receive", "send"]);
  });

  it("posts the turn while the receive poll is still waiting for its headers", async () => {
    let release = () => {};
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const order = [];
    let sentWhilePending = false;
    const transport = async (_url, options) => {
      if (options.method === "GET") {
        order.push("receive");
        await gate;
        sentWhilePending = true;
        return new Response(completedBody());
      }
      if (isOpen(options)) return openReply();
      order.push("send");
      release();
      return new Response("[[0,0,0]]");
    };

    const response = await run({ transport });

    expect(sentWhilePending).toBe(true);
    expect(order).toEqual(["receive", "send"]);
    expect(await answerOf(response)).toBe(ARGON_BIND_FINAL_TEXT);
  });

  it("continues a heartbeat-only poll without re-sending the generation", async () => {
    let sends = 0;
    const receives = [];
    const transport = async (url, options) => {
      if (options.method === "GET") {
        receives.push(aidOf(url));
        return receives.length === 1
          ? new Response(heartbeatBody)
          : new Response(completedBody());
      }
      if (isOpen(options)) return openReply();
      sends += 1;
      return new Response("[[0,0,0]]");
    };

    const response = await run({ transport });

    expect(await answerOf(response)).toBe(ARGON_BIND_FINAL_TEXT);
    expect(receives).toEqual(["0", "1"]);
    expect(sends).toBe(1);
  });

  it("continues a partial answer on the next poll and acknowledges its sequence", async () => {
    let sends = 0;
    const receives = [];
    const partialSequence = String(bindRecord("partial-answer").sequence);
    const transport = async (url, options) => {
      if (options.method === "GET") {
        receives.push(aidOf(url));
        return receives.length === 1 ? new Response(partialBody()) : new Response(completedBody());
      }
      if (isOpen(options)) return openReply();
      sends += 1;
      return new Response("[[0,0,0]]");
    };

    const response = await run({ transport });

    expect(await answerOf(response)).toBe(ARGON_BIND_FINAL_TEXT);
    expect(receives).toEqual(["0", partialSequence]);
    expect(sends).toBe(1);
  });

  it("cancels the armed receive when the turn POST is rejected", async () => {
    let cancelled = false;
    const transport = async (_url, options) => {
      if (options.method === "GET") {
        return new Response(
          new ReadableStream({
            start() {},
            cancel() {
              cancelled = true;
            },
          })
        );
      }
      if (isOpen(options)) return openReply();
      return new Response("rejected", { status: 401 });
    };

    const response = await run({ transport });
    await Promise.resolve();

    expect(response.status).toBe(401);
    expect(isNonReplayableResponse(response)).toBe(false);
    expect(cancelled).toBe(true);
  });

  it("marks a receive rejected after the turn was accepted as non-replayable", async () => {
    let sends = 0;
    const transport = async (_url, options) => {
      if (options.method === "GET") return new Response("rejected", { status: 401 });
      if (isOpen(options)) return openReply();
      sends += 1;
      return new Response("[[0,0,0]]");
    };

    const response = await run({ transport });

    expect(response.status).toBe(401);
    expect(isNonReplayableResponse(response)).toBe(true);
    expect(sends).toBe(1);
  });

  it("stops polling on cancellation without posting the turn again", async () => {
    const controller = new AbortController();
    let sends = 0;
    let receives = 0;
    const transport = async (_url, options) => {
      if (options.method === "GET") {
        receives += 1;
        if (receives > 2) throw new Error("the cancelled turn must not keep polling");
        return new Response(new ReadableStream({ start() {} }));
      }
      if (isOpen(options)) return openReply();
      sends += 1;
      return new Response("[[0,0,0]]");
    };

    const pending = run({ transport, signal: controller.signal }).catch((caught) => caught);
    // The receive starts before the send, so it is already outstanding when the
    // send response settles; the abort below reaches that open poll.
    await vi.waitFor(() => expect(sends).toBe(1));
    controller.abort(new Error("client cancelled"));
    const error = await pending;

    expect(error?.name).toBe("AbortError");
    expect(sends).toBe(1);
    expect(receives).toBe(1);
  });

  it("ends every poll on the turn's own deadline instead of restarting it", async () => {
    vi.useFakeTimers();
    try {
      let sends = 0;
      let receives = 0;
      const transport = async (_url, options) => {
        if (options.method === "GET") {
          receives += 1;
          return new Response(new ReadableStream({ start() {} }));
        }
        if (isOpen(options)) return openReply();
        sends += 1;
        return new Response("[[0,0,0]]");
      };

      const pending = run({ transport }).catch((caught) => caught);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(GEMINI_WEB_LIMITS.generationTimeoutMs);
      const error = await pending;

      expect(error).toMatchObject({ status: 502, code: "gemini_web_upstream_error" });
      expect(String(error.message)).toContain("timed out");
      expect(sends).toBe(1);
      expect(receives).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  }, 5000);

  it("spends one deadline across the channel open and a rollover", async () => {
    vi.useFakeTimers();
    try {
      let sends = 0;
      let receives = 0;
      const transport = async (_url, options) => {
        if (isOpen(options)) {
          // The channel handshake alone consumes most of the turn's budget.
          await new Promise((resolve) => setTimeout(resolve, 200000));
          return openReply();
        }
        if (options.method === "GET") {
          receives += 1;
          return receives === 1
            ? new Response(heartbeatBody)
            : new Response(new ReadableStream({ start() {} }));
        }
        sends += 1;
        return new Response("[[0,0,0]]");
      };

      const pending = run({ transport }).catch((caught) => caught);
      // Open resolves, the turn is posted, the heartbeat poll rolls over and
      // the rearmed poll is left waiting.
      await vi.advanceTimersByTimeAsync(200000);
      expect(sends).toBe(1);
      expect(receives).toBe(2);
      // The remainder of the original budget still ends the rearmed poll.
      await vi.advanceTimersByTimeAsync(GEMINI_WEB_LIMITS.generationTimeoutMs - 200000 + 1);
      const error = await pending;

      expect(error).toMatchObject({ status: 502, code: "gemini_web_upstream_error" });
      expect(String(error.message)).toContain("timed out");
      expect(sends).toBe(1);
      expect(receives).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  }, 8000);

  it("classifies an open response body that stalls past the deadline as a timeout", async () => {
    vi.useFakeTimers();
    try {
      const transport = async (_url, options) => {
        if (isOpen(options)) return new Response(stallingBody(options.signal));
        throw new Error("the turn must not be posted while the open body stalls");
      };

      const pending = run({ transport }).catch((caught) => caught);
      await vi.advanceTimersByTimeAsync(GEMINI_WEB_LIMITS.generationTimeoutMs + 1);
      const error = await pending;

      // The transport surfaces the internal deadline as an AbortError on the
      // body read; that must not be mistaken for the caller cancelling.
      expect(error).toMatchObject({ status: 502, code: "gemini_web_upstream_error" });
      expect(String(error.message)).toContain("timed out");
    } finally {
      vi.useRealTimers();
    }
  }, 5000);

  it("classifies a send acknowledgement body that stalls past the deadline as a timeout", async () => {
    vi.useFakeTimers();
    try {
      let sends = 0;
      const transport = async (_url, options) => {
        if (isOpen(options)) return openReply();
        if (options.method === "GET") return new Response(new ReadableStream({ start() {} }));
        sends += 1;
        return new Response(stallingBody(options.signal));
      };

      const pending = run({ transport }).catch((caught) => caught);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(GEMINI_WEB_LIMITS.generationTimeoutMs + 1);
      const error = await pending;

      expect(error).toMatchObject({ status: 502, code: "gemini_web_upstream_error" });
      expect(String(error.message)).toContain("timed out");
      expect(sends).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  }, 5000);

  it("reassembles a raw length-prefixed answer split across two polls", async () => {
    const whole = streamBodyFromAnswerText("pong");
    const middle = Math.floor(whole.length / 2);
    const receives = [];
    let sends = 0;
    const transport = async (url, options) => {
      if (options.method === "GET") {
        receives.push(aidOf(url));
        return new Response(
          receives.length === 1 ? whole.slice(0, middle) : whole.slice(middle)
        );
      }
      if (isOpen(options)) return openReply();
      sends += 1;
      return new Response("[[0,0,0]]");
    };

    const response = await run({ transport });

    expect(await answerOf(response)).toBe("pong");
    // The split frame carries no applied record, so the rearm still asks from 0.
    expect(receives).toEqual(["0", "0"]);
    expect(sends).toBe(1);
  });

  it("keeps a caller abort during an open body read an abort", async () => {
    const controller = new AbortController();
    let opened = () => {};
    const openStarted = new Promise((resolve) => {
      opened = resolve;
    });
    const transport = async (_url, options) => {
      if (!isOpen(options)) throw new Error("unexpected request");
      opened();
      return new Response(stallingBody(options.signal));
    };

    const pending = run({ transport, signal: controller.signal }).catch((caught) => caught);
    await openStarted;
    controller.abort(new Error("client cancelled"));
    const error = await pending;

    expect(error?.name).toBe("AbortError");
    expect(error?.status).toBeUndefined();
  }, 5000);

  it("keeps polling a channel that only ever answers with heartbeats", async () => {
    let sends = 0;
    let receives = 0;
    const transport = async (_url, options) => {
      if (options.method === "GET") {
        receives += 1;
        return new Response(heartbeatBody);
      }
      if (isOpen(options)) return openReply();
      sends += 1;
      return new Response("[[0,0,0]]");
    };

    const error = await run({ transport }).catch((caught) => caught);

    expect(error).toMatchObject({ status: 502, code: "gemini_web_upstream_error" });
    expect(String(error.message)).toContain("ended before the turn reported completion");
    expect(sends).toBe(1);
    expect(receives).toBe(GEMINI_WEB_LIMITS.bindPollLimit);
  }, 5000);

  it.each([
    { control: "stop", message: "stopped the turn" },
    { control: "close", message: "channel closed" },
  ])("treats a $control control as a channel error, not an answer", async ({ control, message }) => {
    let sends = 0;
    let receives = 0;
    const transport = async (_url, options) => {
      if (options.method === "GET") {
        receives += 1;
        return new Response(`8\n[[1,["${control}"]]]\n`);
      }
      if (isOpen(options)) return openReply();
      sends += 1;
      return new Response("[[0,0,0]]");
    };

    const error = await run({ transport }).catch((caught) => caught);

    expect(error).toMatchObject({ status: 502, code: "gemini_web_upstream_error" });
    expect(String(error.message)).toContain(message);
    expect(sends).toBe(1);
    expect(receives).toBe(1);
  });

  // Literal body of the rejected Argon GET captured from the live wire: the
  // service error names the missing API consumer identity, then the channel
  // closes on the next record.
  const SERVICE_ERROR_MESSAGE =
    "Method doesn't allow unregistered callers (callers without established identity). " +
    "Please use API Key or other form of API consumer identity to call this API.";
  const serviceErrorBody = () =>
    `[[1,{"__sm__":{"status":[[{"error":{"code":403,"message":${JSON.stringify(
      SERVICE_ERROR_MESSAGE
    )},"status":"PERMISSION_DENIED"}}]]}}],[2,["close"]]]`;

  it("surfaces the channel's service error with its upstream status", async () => {
    let sends = 0;
    let receives = 0;
    const transport = async (_url, options) => {
      if (options.method === "GET") {
        receives += 1;
        return new Response(serviceErrorBody());
      }
      if (isOpen(options)) return openReply();
      sends += 1;
      return new Response("[[0,0,0]]");
    };

    const error = await run({ transport }).catch((caught) => caught);

    expect(error).toMatchObject({ status: 403, code: "gemini_web_upstream_error" });
    expect(String(error.message)).toContain("PERMISSION_DENIED");
    expect(String(error.message)).toContain("unregistered callers");
    expect(error.nonReplayable).toBe(true);
    expect(sends).toBe(1);
    expect(receives).toBe(1);
  });

  it("surfaces a service error carried by the send acknowledgement", async () => {
    let sends = 0;
    let receives = 0;
    const transport = async (_url, options) => {
      if (options.method === "GET") {
        receives += 1;
        return new Response(new ReadableStream({ start() {} }));
      }
      if (isOpen(options)) return openReply();
      sends += 1;
      return new Response(serviceErrorBody());
    };

    const error = await run({ transport }).catch((caught) => caught);

    expect(error).toMatchObject({ status: 403, code: "gemini_web_upstream_error" });
    expect(String(error.message)).toContain("unregistered callers");
    expect(error.nonReplayable).toBe(true);
    expect(sends).toBe(1);
    expect(receives).toBe(1);
  });

  it("applies a control whose record id is at or below the acknowledged cursor", async () => {
    let sends = 0;
    let receives = 0;
    const partialSequence = bindRecord("partial-answer").sequence;
    const transport = async (_url, options) => {
      if (options.method === "GET") {
        receives += 1;
        return receives === 1
          ? new Response(partialBody())
          : new Response(`8\n[[${partialSequence},["stop"]]]\n`);
      }
      if (isOpen(options)) return openReply();
      sends += 1;
      return new Response("[[0,0,0]]");
    };

    const error = await run({ transport }).catch((caught) => caught);

    expect(error).toMatchObject({ status: 502, code: "gemini_web_upstream_error" });
    expect(String(error.message)).toContain("stopped the turn");
    expect(sends).toBe(1);
    expect(receives).toBe(2);
  });

  it.each([100, 200, 302])("normalizes a non-error service status %s to 502", async (status) => {
    const transport = async (_url, options) => {
      if (options.method === "GET") {
        return new Response(serviceErrorBody().replace('"code":403', `"code":${status}`));
      }
      return isOpen(options) ? openReply() : new Response("[[0,0,0]]");
    };

    const error = await run({ transport }).catch((caught) => caught);
    expect(error).toMatchObject({ status: 502, nonReplayable: true });
    expect(String(error.message)).toContain("unregistered callers");
  });
});
