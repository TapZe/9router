import { describe, expect, it, vi } from "vitest";

import { GEMINI_WEB_LIMITS } from "../../open-sse/executors/gemini-web/config.js";
import {
  assertGeminiWebInputImageBudget,
  decodeGeminiWebImageDataUrl,
  downloadGeminiWebImage,
  isAllowedGeminiMediaUrl,
  uploadGeminiWebImage,
} from "../../open-sse/executors/gemini-web/media.js";
import {
  HTML_BYTES,
  JPEG_DATA_URL,
  PNG_DATA_URL,
  SVG_BYTES,
  TINY_JPEG,
  TINY_PNG,
  TINY_WEBP,
  WEBP_DATA_URL,
  toDataUrl,
} from "../fixtures/gemini-web/imageFixtures.js";
import { SYNTHETIC_COOKIE, SYNTHETIC_GOOGLE_SESSION } from "../fixtures/gemini-web/wireFixtures.js";

const SESSION = Object.freeze({
  cookieHeader: SYNTHETIC_COOKIE,
  at: "synthetic-at-token",
  pushId: "feeds/synthetic-push",
  buildLabel: "synthetic-build-label",
  sessionId: SYNTHETIC_GOOGLE_SESSION,
  language: "en",
  generationId: "11111111-2222-3333-4444-555555555555",
  models: [],
});

function createTransport(handler) {
  const calls = [];
  const transport = vi.fn(async (url, options = {}, proxyOptions = null) => {
    const call = { url: String(url), options, proxyOptions };
    calls.push(call);
    return handler(call);
  });
  return { transport, calls };
}

function header(call, name) {
  const headers = call.options.headers || {};
  const found = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase());
  return found ? headers[found] : undefined;
}

function bodyOf(call) {
  const body = call.options.body;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  return body;
}

function downloadTransport(bytes, { mime = "image/png", init = {} } = {}) {
  return createTransport(
    () =>
      new Response(bytes, {
        status: 200,
        headers: { "content-type": mime },
        ...init,
      })
  );
}

async function catchError(promise) {
  return promise.catch((caught) => caught);
}

describe("Gemini Web image input", () => {
  it("accepts PNG, JPEG and WebP data URLs with matching magic bytes", () => {
    expect(decodeGeminiWebImageDataUrl(PNG_DATA_URL)).toMatchObject({
      mime: "image/png",
      extension: "png",
    });
    expect(Buffer.from(decodeGeminiWebImageDataUrl(PNG_DATA_URL).data)).toEqual(TINY_PNG);
    expect(decodeGeminiWebImageDataUrl(JPEG_DATA_URL)).toMatchObject({
      mime: "image/jpeg",
      extension: "jpg",
    });
    expect(decodeGeminiWebImageDataUrl(WEBP_DATA_URL)).toMatchObject({
      mime: "image/webp",
      extension: "webp",
    });
  });

  it.each([
    "https://lh3.googleusercontent.com/image.png",
    "data:image/svg+xml;base64," + SVG_BYTES.toString("base64"),
    "data:image/gif;base64,R0lGODlhAQABAAAAACw=",
    "data:image/png;base64,!!!!",
    "data:image/png;base64,",
    toDataUrl("image/png", HTML_BYTES),
    toDataUrl("image/png", TINY_JPEG),
    toDataUrl("image/jpeg", TINY_PNG),
  ])("rejects malformed, remote or mismatched image input %s with 400", (input) => {
    expect(() => decodeGeminiWebImageDataUrl(input)).toThrowError(
      expect.objectContaining({ status: 400 })
    );
  });

  it("enforces the 32 MiB aggregate input budget with 413", () => {
    expect(() =>
      assertGeminiWebInputImageBudget(GEMINI_WEB_LIMITS.inputImagesBytes)
    ).not.toThrow();
    expect(() =>
      assertGeminiWebInputImageBudget(GEMINI_WEB_LIMITS.inputImagesBytes + 1)
    ).toThrowError(expect.objectContaining({ status: 413 }));
    expect(() =>
      assertGeminiWebInputImageBudget([GEMINI_WEB_LIMITS.inputImagesBytes / 2, GEMINI_WEB_LIMITS.inputImagesBytes / 2 + 1])
    ).toThrowError(expect.objectContaining({ status: 413 }));
  });
});

describe("Gemini Web image upload", () => {
  function uploadTransport({ uploadUrl = "https://content-push.googleapis.com/session-1", fileId = "file-id-123", redirectPost = false } = {}) {
    return createTransport((call) => {
      const method = call.options.method;
      const url = call.url;
      if (method === "OPTIONS" && url.endsWith("/upload")) {
        return new Response(null, { status: 200 });
      }
      if (method === "POST" && url.endsWith("/upload")) {
        if (redirectPost) {
          return new Response(null, {
            status: 302,
            headers: { location: "https://evil.example/collect" },
          });
        }
        return new Response(null, {
          status: 200,
          headers: { "x-goog-upload-url": uploadUrl },
        });
      }
      if (method === "OPTIONS" && url.endsWith("/session-1")) {
        return new Response(null, { status: 200 });
      }
      if (method === "POST" && url.endsWith("/session-1")) {
        return new Response(fileId, { status: 200 });
      }
      throw new Error(`unexpected upload request: ${method} ${url}`);
    });
  }

  it("runs OPTIONS/start/OPTIONS/finalize with the reference upload headers", async () => {
    const { transport, calls } = uploadTransport();
    const file = { name: "image.png", mimeType: "image/png", data: TINY_PNG };

    const uploaded = await uploadGeminiWebImage(SESSION, file, {
      proxyOptions: { enabled: false },
      transport,
    });

    expect(uploaded).toEqual({ id: "file-id-123", name: "image.png" });
    expect(calls).toHaveLength(4);
    const [prepare, start, prepareUrl, finalize] = calls;
    expect(prepare.options.method).toBe("OPTIONS");
    expect(prepare.url).toBe("https://content-push.googleapis.com/upload");
    expect(header(prepare, "authorization")).toBe(
      "Basic c2F2ZXM6cyNMdGhlNmxzd2F2b0RsN3J1d1U="
    );
    expect(header(prepare, "push-id")).toBe("feeds/synthetic-push");
    expect(header(prepare, "x-goog-upload-protocol")).toBe("resumable");
    expect(header(prepare, "x-goog-upload-command")).toBe("start");
    expect(header(prepare, "x-goog-upload-header-content-length")).toBe(String(TINY_PNG.length));
    expect(header(prepare, "x-tenant-id")).toBe("bard-storage");
    expect(header(prepare, "origin")).toBe("https://gemini.google.com");
    expect(header(prepare, "referer")).toBe("https://gemini.google.com/");
    expect(header(prepare, "cookie")).toBe(SYNTHETIC_COOKIE);
    expect(header(prepare, "content-type")).toBe(
      "application/x-www-form-urlencoded;charset=UTF-8"
    );

    expect(start.options.method).toBe("POST");
    expect(bodyOf(start)).toBe("File name: image.png");
    expect(header(start, "size")).toBe(String(TINY_PNG.length));
    expect(header(start, "x-goog-upload-protocol")).toBe("resumable");

    expect(prepareUrl.options.method).toBe("OPTIONS");
    expect(prepareUrl.url).toBe("https://content-push.googleapis.com/session-1");

    expect(finalize.options.method).toBe("POST");
    expect(finalize.url).toBe("https://content-push.googleapis.com/session-1");
    expect(header(finalize, "content-type")).toBe("image/png");
    expect(header(finalize, "x-goog-upload-command")).toBe("upload, finalize");
    expect(header(finalize, "x-goog-upload-offset")).toBe("0");
    expect(Buffer.from(bodyOf(finalize))).toEqual(TINY_PNG);

    for (const call of calls) {
      expect(call.options.redirect).toBe("manual");
      expect(call.options.strictTls).toBe(true);
      expect(call.options.maxHeaderSize).toBe(GEMINI_WEB_LIMITS.maxHeaderSize);
      expect(call.options.forceFreshSocket).toBe(true);
      expect(call.proxyOptions).toMatchObject({ enabled: false, strictProxy: true });
    }
  });

  it("fails with 502 when the upload returns no file id", async () => {
    const { transport } = uploadTransport({ fileId: "" });
    const error = await catchError(
      uploadGeminiWebImage(
        SESSION,
        { name: "image.png", mimeType: "image/png", data: TINY_PNG },
        { transport }
      )
    );
    expect(error).toMatchObject({ status: 502, code: "gemini_web_upstream_error" });
  });

  it.each([
    "http://content-push.googleapis.com/session-1",
    "https://evil.example/session-1",
    "https://user:pass@content-push.googleapis.com/session-1",
    "https://content-push.googleapis.com:8443/session-1",
  ])("rejects untrusted upload URL %s before sending credentials", async (uploadUrl) => {
    const { transport, calls } = uploadTransport({ uploadUrl });
    const error = await catchError(
      uploadGeminiWebImage(
        SESSION,
        { name: "image.png", mimeType: "image/png", data: TINY_PNG },
        { transport }
      )
    );

    expect(error).toMatchObject({ status: 502, code: "gemini_web_upstream_error" });
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => !/evil\.example|:8443|user:pass/.test(call.url))).toBe(true);
  });

  it("refuses an upload POST redirect without replaying it", async () => {
    const { transport, calls } = uploadTransport({ redirectPost: true });
    const error = await catchError(
      uploadGeminiWebImage(
        SESSION,
        { name: "image.png", mimeType: "image/png", data: TINY_PNG },
        { transport }
      )
    );
    expect(error).toMatchObject({ status: 502 });
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => !call.url.includes("evil.example"))).toBe(true);
  });

  it("rejects oversized, unsupported or mismatched upload bytes before any request", async () => {
    const oversized = Buffer.alloc(GEMINI_WEB_LIMITS.inputImagesBytes + 1);
    const { transport, calls } = createTransport(() => {
      throw new Error("must not upload");
    });

    for (const [file, status] of [
      [{ name: "huge.png", mimeType: "image/png", data: oversized }, 413],
      [{ name: "image.gif", mimeType: "image/gif", data: TINY_PNG }, 400],
      [{ name: "image.png", mimeType: "image/png", data: TINY_JPEG }, 400],
      [{ name: "image.png", mimeType: "image/png", data: Buffer.alloc(0) }, 400],
    ]) {
      const error = await catchError(uploadGeminiWebImage(SESSION, file, { transport }));
      expect(error).toMatchObject({ status });
    }
    expect(calls).toHaveLength(0);
  });
});

describe("Gemini Web media URL policy", () => {
  it.each([
    "https://gemini.google.com/image",
    "https://lh3.googleusercontent.com/generated-image",
    "https://googleusercontent.com/generated-image",
    "https://usercontent.google.com/image",
    "https://work.fife.usercontent.google.com/image",
  ])("allows trusted media host %s", (url) => {
    expect(isAllowedGeminiMediaUrl(url)).toBe(true);
  });

  it.each([
    "http://lh3.googleusercontent.com/image",
    "https://google.com/image",
    "https://accounts.google.com/image",
    "https://googleusercontent.com.evil.example/image",
    "https://usercontent.google.com.evil.example/image",
    "https://evil-usercontent.google.com/image",
    "https://lh3.googleusercontent.com:8443/image",
    "https://user:pass@lh3.googleusercontent.com/image",
    "//lh3.googleusercontent.com/image",
    "https://evil.example/image",
    "",
  ])("rejects untrusted media URL %s", (url) => {
    expect(isAllowedGeminiMediaUrl(url)).toBe(false);
  });
});

describe("Gemini Web image download", () => {
  it("downloads a generated image with the sizing transform and no invented authuser parameter", async () => {
    const { transport, calls } = downloadTransport(TINY_PNG);
    const result = await downloadGeminiWebImage(
      SESSION,
      { url: "https://lh3.googleusercontent.com/generated-image?download=1" },
      { proxyOptions: { enabled: false }, transport }
    );

    expect(result.mime).toBe("image/png");
    expect(Buffer.from(result.b64, "base64")).toEqual(TINY_PNG);

    const call = calls[0];
    const url = new URL(call.url);
    expect(url.hostname).toBe("lh3.googleusercontent.com");
    expect(url.pathname).toBe("/generated-image=s2048");
    expect(url.searchParams.get("download")).toBe("1");
    expect(url.searchParams.has("authuser")).toBe(false);
    expect(header(call, "cookie")).toBe(SYNTHETIC_COOKIE);
    expect(header(call, "referer")).toBe("https://gemini.google.com/");
    expect(call.options.redirect).toBe("manual");
    expect(call.options.strictTls).toBe(true);
    expect(call.options.maxHeaderSize).toBe(GEMINI_WEB_LIMITS.maxHeaderSize);
    expect(call.options.forceFreshSocket).toBeUndefined();
    expect(call.proxyOptions).toMatchObject({ enabled: false, strictProxy: true });
  });

  it("selects a nondefault Google slot with authuser so the download is not authorized as account 0", async () => {
    const { transport, calls } = downloadTransport(TINY_PNG);
    await downloadGeminiWebImage(
      SESSION,
      { url: "https://lh3.googleusercontent.com/generated-image" },
      { transport, authUser: "6" }
    );
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/generated-image=s2048");
    expect(url.searchParams.get("authuser")).toBe("6");
  });

  it("preserves an existing image transform", async () => {
    const { transport, calls } = downloadTransport(TINY_PNG);
    await downloadGeminiWebImage(
      SESSION,
      { url: "https://lh3.googleusercontent.com/image=w1024-h1024?download=1" },
      { transport }
    );
    expect(new URL(calls[0].url).pathname).toBe("/image=w1024-h1024");
  });

  it("rejects an untrusted download host before sending any request", async () => {
    const { transport, calls } = createTransport(() => {
      throw new Error("must not request");
    });
    const error = await catchError(
      downloadGeminiWebImage(SESSION, { url: "https://evil.example/image.png" }, { transport })
    );
    expect(error).toMatchObject({ status: 502 });
    expect(calls).toHaveLength(0);
  });

  it("follows trusted redirects, keeping the cookie only on allowed hosts", async () => {
    const firstHop = `https://lh3.googleusercontent.com/image=s${GEMINI_WEB_LIMITS.generatedImageSize}`;
    const { transport, calls } = createTransport((call) => {
      if (call.url === firstHop) {
        return new Response(null, {
          status: 302,
          headers: {
            location: "https://work.fife.usercontent.google.com/image?authuser=2",
          },
        });
      }
      if (call.url === "https://work.fife.usercontent.google.com/image?authuser=2") {
        return new Response(TINY_PNG, {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      throw new Error(`unexpected request: ${call.url}`);
    });

    const result = await downloadGeminiWebImage(
      SESSION,
      { url: "https://lh3.googleusercontent.com/image" },
      { transport }
    );
    expect(Buffer.from(result.b64, "base64")).toEqual(TINY_PNG);
    expect(calls).toHaveLength(2);

    // The provider applies the sizing transform to the original URL only.
    const first = new URL(calls[0].url);
    expect(first.pathname).toBe("/image=s2048");
    expect(first.searchParams.has("authuser")).toBe(false);
    expect(header(calls[0], "cookie")).toBe(SYNTHETIC_COOKIE);

    // A redirect hop keeps the trusted host and the cookie, but the provider
    // never invents an authuser parameter: this one came from Google.
    const second = new URL(calls[1].url);
    expect(second.hostname).toBe("work.fife.usercontent.google.com");
    expect(second.searchParams.get("authuser")).toBe("2");
    expect(second.pathname).toBe("/image");
    expect(header(calls[1], "cookie")).toBe(SYNTHETIC_COOKIE);
  });

  it("refuses a redirect to an untrusted host before requesting it", async () => {
    const { transport, calls } = createTransport(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.example/collect" },
        })
    );
    const error = await catchError(
      downloadGeminiWebImage(
        SESSION,
        { url: "https://lh3.googleusercontent.com/image" },
        { transport }
      )
    );
    expect(error).toMatchObject({ status: 502 });
    expect(calls).toHaveLength(1);
  });

  it("stops after five redirects", async () => {
    let hop = 0;
    const { transport, calls } = createTransport(() => {
      hop += 1;
      return new Response(null, {
        status: 302,
        headers: { location: `https://lh3.googleusercontent.com/image?hop=${hop}` },
      });
    });
    const error = await catchError(
      downloadGeminiWebImage(
        SESSION,
        { url: "https://lh3.googleusercontent.com/image" },
        { transport }
      )
    );
    expect(error).toMatchObject({ status: 502 });
    expect(calls.length).toBeLessThanOrEqual(GEMINI_WEB_LIMITS.maxRedirects + 1);
  });

  it.each([
    { name: "SVG", mime: "image/svg+xml", bytes: SVG_BYTES },
    { name: "HTML labeled PNG", mime: "image/png", bytes: HTML_BYTES },
    { name: "JPEG labeled PNG", mime: "image/png", bytes: TINY_JPEG },
  ])("rejects $name bytes with 502", async ({ mime, bytes }) => {
    const { transport } = downloadTransport(bytes, { mime });
    const error = await catchError(
      downloadGeminiWebImage(
        SESSION,
        { url: "https://lh3.googleusercontent.com/image" },
        { transport }
      )
    );
    expect(error).toMatchObject({ status: 502, code: "gemini_web_upstream_error" });
  });

  it.each([
    { mime: "image/jpeg", bytes: TINY_JPEG, extension: "jpeg" },
    { mime: "image/webp", bytes: TINY_WEBP, extension: "webp" },
  ])("accepts $mime generated image bytes", async ({ mime, bytes }) => {
    const { transport } = downloadTransport(bytes, { mime });
    const result = await downloadGeminiWebImage(
      SESSION,
      { url: "https://lh3.googleusercontent.com/image" },
      { transport }
    );
    expect(result.mime).toBe(mime);
    expect(Buffer.from(result.b64, "base64")).toEqual(bytes);
  });

  it("rejects a generated image larger than 32 MiB", async () => {
    const oversized = new ReadableStream({
      start(controller) {
        const chunk = new Uint8Array(1024 * 1024).fill(0x89);
        for (let index = 0; index < 33; index += 1) controller.enqueue(chunk);
        controller.close();
      },
    });
    const { transport } = createTransport(
      () => new Response(oversized, { status: 200, headers: { "content-type": "image/png" } })
    );
    const error = await catchError(
      downloadGeminiWebImage(
        SESSION,
        { url: "https://lh3.googleusercontent.com/image" },
        { transport }
      )
    );
    expect(error).toMatchObject({ status: 502 });
  });

  it("rejects a non-image content type even on a trusted host", async () => {
    const { transport } = downloadTransport(TINY_PNG, { mime: "text/html" });
    const error = await catchError(
      downloadGeminiWebImage(
        SESSION,
        { url: "https://lh3.googleusercontent.com/image" },
        { transport }
      )
    );
    expect(error).toMatchObject({ status: 502 });
  });
});
