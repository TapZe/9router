// Node HTTP/1 transport for Gemini Web.
//
// Ported from gemini-web-to-api (MIT). See LICENSE in this directory.
// Copyright (c) 2025 Nguyễn Tuấn Thành
//
// undici's SOCKS path cannot honor a destination maxHeaderSize, and Gemini's
// bootstrap page plus batchexecute replies exceed Node's 16 KiB default. This
// adapter drives Node's own http/https client for the direct and SOCKS cases so
// the 2 MiB parser limit applies; HTTP CONNECT proxies keep using undici.

import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { proxyAwareFetch } from "../../utils/proxyFetch.js";

import {
  GEMINI_WEB_LIMITS,
  abortError,
  geminiWebError,
  throwIfAborted,
  upstreamError,
} from "./config.js";

const SOCKS_PROTOCOLS = Object.freeze(["socks:", "socks5:", "socks5h:", "socks4:", "socks4a:"]);

const socksAgents = new Map();

function isSocksProxy(proxyUrl) {
  try {
    return SOCKS_PROTOCOLS.includes(new URL(proxyUrl).protocol);
  } catch {
    return false;
  }
}

async function getSocksAgent(proxyUrl) {
  const key = String(proxyUrl);
  const cached = socksAgents.get(key);
  if (cached) return cached;
  const { SocksProxyAgent } = await import("socks-proxy-agent");
  // The agent carries no request state; caching only avoids re-parsing the URL
  // and re-opening the SOCKS control connection for every hop.
  const agent = new SocksProxyAgent(key);
  socksAgents.set(key, agent);
  return agent;
}

function headersToObject(headers) {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) {
    const out = {};
    for (const [name, value] of headers) out[String(name).toLowerCase()] = String(value);
    return out;
  }
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || value === null) continue;
    out[String(name).toLowerCase()] = String(value);
  }
  return out;
}

function responseHeaders(raw) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw.headers || {})) {
    if (value === undefined) continue;
    const distinct = raw.headersDistinct?.[name];
    const values = distinct ?? (Array.isArray(value) ? value : [value]);
    for (const entry of values) headers.append(name, String(entry));
  }
  return headers;
}

function decoderFor(encoding) {
  const value = String(encoding || "").toLowerCase().trim();
  if (value === "gzip" || value === "x-gzip") return createGunzip();
  if (value === "deflate") return createInflate();
  if (value === "br") return createBrotliDecompress();
  return null;
}

function bodyToBuffer(body) {
  if (body === undefined || body === null) return null;
  if (typeof body === "string") return Buffer.from(body);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  return null;
}

function requestOptionsFor(url, options, headers, bodyBuffer) {
  const parsed = new URL(url);
  const isHttps = parsed.protocol === "https:";
  const requestOptions = {
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port: parsed.port || (isHttps ? 443 : 80),
    path: `${parsed.pathname}${parsed.search}`,
    method: (options.method || "GET").toUpperCase(),
    headers,
    maxHeaderSize: Number.isInteger(options.maxHeaderSize)
      ? options.maxHeaderSize
      : GEMINI_WEB_LIMITS.maxHeaderSize,
  };
  if (isHttps) {
    // Gemini Web native traffic always verifies the upstream certificate. This
    // transport has no insecure mode, so strictTls changes nothing here.
    requestOptions.rejectUnauthorized = true;
    requestOptions.ecdhCurve = process.env.NINEROUTER_TLS_ECDH_CURVE || "X25519";
  }
  if (bodyBuffer) {
    const hasLength = Object.keys(headers).some((name) => name === "content-length");
    if (!hasLength) headers["content-length"] = String(bodyBuffer.length);
  }
  return requestOptions;
}

/**
 * Fetch one URL through Node's HTTP/1 client.
 *
 * Verification is always on: this transport has no insecure TLS mode.
 * Direct calls use a one-shot socket (`agent: false`); SOCKS calls reuse a
 * cached SocksProxyAgent that holds no cookie or header state.
 */
export async function geminiWebHttp1Fetch(url, options = {}, proxyUrl = null) {
  throwIfAborted(options.signal);
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    throw upstreamError("Gemini Web transport received an invalid URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw upstreamError("Gemini Web transport only supports HTTP(S) URLs");
  }

  const headers = headersToObject(options.headers);
  const bodyBuffer = bodyToBuffer(options.body);
  const requestOptions = requestOptionsFor(parsed, options, headers, bodyBuffer);

  if (proxyUrl) {
    if (!isSocksProxy(proxyUrl)) {
      throw upstreamError("Gemini Web transport cannot drive this proxy protocol");
    }
    requestOptions.agent = await getSocksAgent(proxyUrl);
  } else {
    // One socket per request: no pooled connection can be replayed after an
    // ambiguous generation, and no cross-request state survives.
    requestOptions.agent = false;
  }

  const transportModule = parsed.protocol === "https:" ? https : http;

  return await new Promise((resolve, reject) => {
    let settled = false;
    let onAbort = () => {};
    let responseStream;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener?.("abort", onAbort);
      reject(error);
    };

    let request;
    try {
      request = transportModule.request(requestOptions, (response) => {
        if (settled) {
          response.resume();
          return;
        }
        let stream = response;
        const decoder = decoderFor(response.headers["content-encoding"]);
        if (decoder) {
          stream = response.pipe(decoder);
        }
        responseStream = stream;
        const noBody =
          requestOptions.method === "HEAD" ||
          response.statusCode === 204 ||
          response.statusCode === 304;
        const webBody = noBody ? null : Readable.toWeb(stream);
        const responseHeadersInit = responseHeaders(response);
        if (decoder) {
          responseHeadersInit.delete("content-encoding");
          responseHeadersInit.delete("content-length");
        }
        const status = Number.isInteger(response.statusCode) ? response.statusCode : 502;
        let result;
        try {
          result = new Response(webBody, {
            status: status >= 200 && status <= 599 ? status : 502,
            statusText: response.statusMessage || "",
            headers: responseHeadersInit,
          });
        } catch (error) {
          response.resume();
          finish(upstreamError("Gemini Web transport produced an invalid response", { cause: error }));
          return;
        }
        settled = true;
        if (noBody) options.signal?.removeEventListener?.("abort", onAbort);
        else stream.once("close", () => options.signal?.removeEventListener?.("abort", onAbort));
        resolve(result);
      });
    } catch (error) {
      finish(upstreamError("Gemini Web transport could not start the request", { cause: error }));
      return;
    }

    onAbort = () => {
      const reason = options.signal?.reason;
      const error = reason?.name === "TimeoutError"
        ? upstreamError("Gemini Web transport timed out", { cause: reason })
        : abortError(reason);
      request.destroy(error);
      responseStream?.destroy(error);
      finish(error);
    };

    // Attach these before the abort wiring below: an abort can destroy this
    // request in the same tick, and a ClientRequest that emits 'error' with no
    // listener takes the whole process down.
    request.on("error", (error) => {
      if (options.signal?.aborted) return finish(abortError(options.signal.reason));
      if (error?.name === "AbortError") return finish(error);
      finish(upstreamError("Gemini Web transport request failed", { cause: error }));
    });
    request.on("timeout", () => {
      request.destroy(new Error("Gemini Web transport timed out"));
    });
    if (Number.isInteger(options.timeoutMs) && options.timeoutMs > 0) {
      request.setTimeout(options.timeoutMs);
    }

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
        return;
      }
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    if (bodyBuffer && bodyBuffer.length > 0) request.write(bodyBuffer);
    request.end();
  });
}

/**
 * Proxy-capable adapter handed to proxyAwareFetch. `proxyProtocols` keeps HTTP
 * CONNECT proxies on undici, where the dispatcher can honor maxHeaderSize.
 */
export async function geminiWebDirectFetch(url, options = {}, proxyUrl = null) {
  const effectiveProxy = proxyUrl || options?.proxyUrl || null;
  if (effectiveProxy && !isSocksProxy(effectiveProxy)) {
    throw geminiWebError("Gemini Web transport does not handle this proxy protocol", {
      status: 502,
    });
  }
  return geminiWebHttp1Fetch(url, options, effectiveProxy);
}

geminiWebDirectFetch.proxyCapable = true;
geminiWebDirectFetch.proxyProtocols = [...SOCKS_PROTOCOLS];

export async function fetchGeminiWeb(url, options = {}, proxyOptions = null) {
  const deadline = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
    ? AbortSignal.timeout(options.timeoutMs)
    : null;
  const signal = deadline
    ? (options.signal ? AbortSignal.any([options.signal, deadline]) : deadline)
    : options.signal;
  try {
    return await proxyAwareFetch(url, { ...options, signal, directFetch: geminiWebDirectFetch }, proxyOptions);
  } catch (error) {
    if (options.signal?.aborted) throw abortError(options.signal.reason);
    if (deadline?.aborted) throw upstreamError("Gemini Web request timed out", { cause: error });
    throw error;
  }
}

/**
 * Read a response body as UTF-8 text without exceeding `limit` bytes. Shared by
 * bootstrap (page HTML) and model discovery so oversized upstream data is a
 * sanitized 502 in both paths.
 */
export async function readGeminiWebBodyText(response, limit) {
  if (!response?.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        throw upstreamError("Gemini Web response exceeds the allowed size");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}
