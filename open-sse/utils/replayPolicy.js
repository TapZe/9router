const NON_REPLAYABLE = Symbol.for("9router.nonReplayableResponse");

export function markNonReplayableResponse(response) {
  if (!response || typeof response !== "object") return response;
  if (Object.prototype.hasOwnProperty.call(response, NON_REPLAYABLE)) return response;
  Object.defineProperty(response, NON_REPLAYABLE, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return response;
}

export function isNonReplayableResponse(response) {
  return response != null && response[NON_REPLAYABLE] === true;
}
