import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { executorMedia } = vi.hoisted(() => ({ executorMedia: { images: [] } }));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: (provider) =>
    provider === "gemini-web"
      ? {
          generateMedia: vi.fn(async () => executorMedia.images),
        }
      : null,
}));

import { handleImageGenerationCore } from "../../open-sse/handlers/imageGenerationCore.js";
import { TINY_JPEG, TINY_PNG, TINY_WEBP } from "../fixtures/gemini-web/imageFixtures.js";

const originalFetch = global.fetch;

function geminiWebRequest(overrides = {}) {
  return {
    body: { prompt: "A synthesized landscape", output_format: "png" },
    modelInfo: { provider: "gemini-web", model: "gemini-3-pro-image" },
    credentials: { providerSpecificData: {} },
    binaryOutput: true,
    ...overrides,
  };
}

describe("binary image output labels the bytes it actually returns", () => {
  beforeEach(() => {
    executorMedia.images = [];
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it("returns Gemini Web JPEG bytes as image/jpeg even when PNG was requested", async () => {
    executorMedia.images = [{ b64: TINY_JPEG.toString("base64"), mime: "image/jpeg" }];

    const result = await handleImageGenerationCore(geminiWebRequest());

    expect(result.success).toBe(true);
    expect(result.response.headers.get("content-type")).toBe("image/jpeg");
    expect(result.response.headers.get("content-disposition")).toBe(
      'inline; filename="image.jpg"'
    );
    expect(Buffer.from(await result.response.arrayBuffer())).toEqual(TINY_JPEG);
  });

  it("returns Gemini Web WebP bytes as image/webp even when JPEG was requested", async () => {
    executorMedia.images = [{ b64: TINY_WEBP.toString("base64"), mime: "image/webp" }];

    const result = await handleImageGenerationCore(
      geminiWebRequest({ body: { prompt: "A synthesized portrait", output_format: "jpeg" } })
    );

    expect(result.success).toBe(true);
    expect(result.response.headers.get("content-type")).toBe("image/webp");
    expect(result.response.headers.get("content-disposition")).toBe(
      'inline; filename="image.webp"'
    );
    expect(Buffer.from(await result.response.arrayBuffer())).toEqual(TINY_WEBP);
  });

  it("does not relabel unconverted Gemini Web PNG bytes as the requested WebP", async () => {
    executorMedia.images = [{ b64: TINY_PNG.toString("base64"), mime: "image/png" }];

    const result = await handleImageGenerationCore(
      geminiWebRequest({ body: { prompt: "A synthesized diagram", output_format: "webp" } })
    );

    expect(result.success).toBe(true);
    expect(result.response.headers.get("content-type")).toBe("image/png");
    expect(result.response.headers.get("content-disposition")).toBe(
      'inline; filename="image.png"'
    );
    expect(Buffer.from(await result.response.arrayBuffer())).toEqual(TINY_PNG);
  });

  it("keeps requested-format labels for adapters that return only base64 bytes", async () => {
    global.fetch = vi.fn(async () =>
      Response.json({ created: 1700000000, data: [{ b64_json: TINY_PNG.toString("base64") }] })
    );

    const result = await handleImageGenerationCore({
      body: { prompt: "A synthesized wave", output_format: "webp" },
      modelInfo: { provider: "openai", model: "gpt-image-1" },
      credentials: { apiKey: "synthetic-key" },
      log: null,
      binaryOutput: true,
    });

    expect(result.success).toBe(true);
    expect(result.response.headers.get("content-type")).toBe("image/webp");
    expect(result.response.headers.get("content-disposition")).toBe(
      'inline; filename="image.webp"'
    );
  });

  it.each(["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"])(
    "falls back to the requested format for the non-image type %s and keeps the bytes",
    async (declared) => {
      const bytes = TINY_JPEG;
      global.fetch = vi.fn(async () =>
        Response.json({
          created: 1700000000,
          data: [{ b64_json: bytes.toString("base64"), mime_type: declared }],
        })
      );

      const result = await handleImageGenerationCore({
        body: { prompt: "A synthesized shell", output_format: "webp" },
        modelInfo: { provider: "openai", model: "gpt-image-1" },
        credentials: { apiKey: "synthetic-key" },
        log: null,
        binaryOutput: true,
      });

      expect(result.success).toBe(true);
      expect(result.response.headers.get("content-type")).toBe("image/webp");
      expect(result.response.headers.get("content-disposition")).toBe(
        'inline; filename="image.webp"'
      );
      expect(Buffer.from(await result.response.arrayBuffer())).toEqual(bytes);
    }
  );

  it("falls back to PNG for an inherited-property type on the Gemini Web path", async () => {
    executorMedia.images = [{ b64: TINY_JPEG.toString("base64"), mime: "__proto__" }];

    const result = await handleImageGenerationCore(
      geminiWebRequest({ body: { prompt: "A synthesized shell" } })
    );

    expect(result.success).toBe(true);
    expect(result.response.headers.get("content-type")).toBe("image/png");
    expect(result.response.headers.get("content-disposition")).toBe(
      'inline; filename="image.png"'
    );
    expect(Buffer.from(await result.response.arrayBuffer())).toEqual(TINY_JPEG);
  });
});
