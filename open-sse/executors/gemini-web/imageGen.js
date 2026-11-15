// Gemini Web image prompt shaping.
//
// The image task reuses the same native generation turn as chat; only the text
// prompt differs, so it stays a pure helper with no browser control.

/**
 * Ask Gemini Web for one image at the requested aspect ratio.
 *
 * @param {string} prompt - the caller's image description
 * @param {string|null|undefined} size - aspect ratio hint (e.g. "16:9")
 * @returns {string}
 */
export function buildImagePrompt(prompt, size) {
  const hints = size ? ` (aspect ratio ${size})` : "";
  return `Generate an image${hints}: ${prompt}`;
}
