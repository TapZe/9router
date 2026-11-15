// Minimal synthetic image bytes. Only the container magic is significant to the
// provider's sniffing rules; these fixtures prove PNG/JPEG/WebP acceptance and
// SVG/HTML rejection without embedding real account content.

export const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

// SOI + APP0/JFIF marker + EOI. Not a decodable photograph, but a valid JPEG
// container signature for the provider's magic-byte gate.
export const TINY_JPEG = Buffer.from(
  "ffd8ffe000104a46494600010100000100010000ffd9",
  "hex"
);

// RIFF....WEBP with a VP8 chunk header.
export const TINY_WEBP = Buffer.from(
  "524946460c000000574542505650382000000000",
  "hex"
);

export const HTML_BYTES = Buffer.from("<html><body>not an image</body></html>", "utf8");
export const SVG_BYTES = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>',
  "utf8"
);

export function toDataUrl(mime, bytes) {
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
}

export const PNG_DATA_URL = toDataUrl("image/png", TINY_PNG);
export const JPEG_DATA_URL = toDataUrl("image/jpeg", TINY_JPEG);
export const WEBP_DATA_URL = toDataUrl("image/webp", TINY_WEBP);
