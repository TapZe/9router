// Literal Gemini Web Bind capture, sanitized for repository use.
//
// Provenance: the /v1/processSession Bind response body for one "Code &
// analysis" turn, captured 2026-11-16 through CDP Network.streamResourceContent
// against a dedicated test account whose prompt asked for exactly one line.
// The turn streamed a partial answer, a completed answer, then a progress
// label. Request headers, cookies and the account's identity are not part of
// this file.
//
// Sanitization: identifiers and account-derived metadata were replaced in
// place with same-length placeholders. Every protobuf tag, wire type, length
// prefix, field number and the answer/label bytes are unchanged, and the
// field tree of each record was verified identical before and after
// sanitizing. Replaced values: conversation id, response id, request id,
// client request id, model hex id, inferred region, region description, map
// tile token.
//
// Record numbers are the sequence numbers Google put in each record, not array
// positions: record 5 is the partial answer turn (turn.1 = 0,
// candidate.15 = 0), record 8 is the completed turn (turn.1 = 1,
// candidate.15 = 1), and record 9 is a progress label with no turn.

/** Answer text carried by the completed record (sequence 8). */
export const ARGON_BIND_FINAL_TEXT = "Working directory: /app";

/** Answer text carried by the partial record (sequence 5). */
export const ARGON_BIND_PARTIAL_TEXT = "Working directory: /";

/** Progress label carried by the trailing record (sequence 9). */
export const ARGON_BIND_PROGRESS_LABEL_TEXT = "Setting Working Directory To App";

/**
 * Captured base64 payloads keyed by their original sequence number. Decoding
 * these literals, not a test encoder, is the contract the provider must meet.
 */
export const ARGON_BIND_RECORDS = Object.freeze([
  Object.freeze({
    sequence: 5,
    kind: "partial-answer",
    payload:
      "EoYeCAM6gR4K/h0IABIUChJyXzAwMDAwMDAwMDAwMDAwMDAi4x0i4B0SKAoSY18wMDAwMDAwMDAwMDAwMDAwEhJyXzAwMDAw" +
      "MDAwMDAwMDAwMDAqPwoTcmNfMDAwMDAwMDAwMDAwMDAwMBIWChRXb3JraW5nIGRpcmVjdG9yeTogL0oCCAFSAmVuagJCAOoB" +
      "ALICADKnAgobUkVEQUNURURfUkVHSU9OWFhYWFhYWFhYWFhYEitSRURBQ1RFRF9BRERSRVNTX0RFU0NSSVBUSU9OWFhYWFhY" +
      "WFhYWFhYWFhYGAAq2AEvL3d3dy5nb29nbGUuY29tL21hcHMvdnQvZGF0YT1BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB" +
      "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB" +
      "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB" +
      "QUFBQUFBQUFBQUFBQUFKAklEeACiAQJlbsABAcoB1BUSBggAEAAYABoMCAAQABgAIAAoADAAIAAquRUKFwoQQWNhZGVtaWMg" +
      "LSBPdGhlchWnR705Cg0KBkNvZGluZxVbGC0+ChcKEENyZWF0aXZlIC0gT3RoZXIV/x42OQoXChBDcmVhdGl2ZSBXcml0aW5n" +
      "FZHqkjoKFwoQQ3VzdG9tZXIgU3VwcG9ydBVfHPo5CiAKGURhaWx5IExpZmUgRXhwZXJ0IC0gT3RoZXIV4FjNNwoiChtEYWls" +
      "eSBMaWZlIFBlcnNvbmFsIC0gT3RoZXIVUqDvOgoUCg1EYXRhIEFuYWx5c2lzFZBzLDsKGAoRRW1vdGlvbmFsIFN1cHBvcnQV" +
      "t78sOAoZChJFbmdhZ2VtZW50IC0gT3RoZXIVGG9VPAoNCgZFdmVudHMVbYGMOQobChRGaW5hbmNlIC8gQWNjb3VudGluZxXN" +
      "Uu06Cg4KB0ZpdG5lc3MVgxBmOAoMCgVHYW1lcxWlDw47ChsKFEdlbmVyYWwgSW5mbyBTZWVraW5nFXbhGTwKFwoQR292ZXJu" +
      "bWVudCAvIExhdxW8bYs5Ch0KFkhSIC8gQ2FyZWVyIE1hbmFnZW1lbnQVPFy3OgoNCgZIZWFsdGgVmmfxOAoVCg5MaWZlIE9y" +
      "Z2FuaXplchWr/Nc+ChgKEUxpZmVsb25nIExlYXJuaW5nFcdjazoKHgoXTWFya2V0aW5nICYgQWR2ZXJ0aXNpbmcVLPOtOQoY" +
      "ChFNZWFscyAvIE51dHJpdGlvbhUXMZA4ChwKFU1lZGlhIC8gRW50ZXJ0YWlubWVudBXgqJk7ChwKFU11bHRpbW9kYWwgR2Vu" +
      "ZXJhdGlvbhXzjmg6ChQKDU5ld3MgLyBTdGF0dXMV6gizOgoXChBQZXJzb25hbCBGaW5hbmNlFYVwnjkKGwoUUHJvZmVzc2lv" +
      "bmFsIC0gT3RoZXIVvf/mPAogChlTYWxlcyAvIE9yZGVyIEZ1bGZpbGxtZW50FWRS/zcKEgoLU2Nob29sIFdvcmsVCykHPgoP" +
      "CghTaG9wcGluZxXGWZw4ChgKEVNvY2lhbCAvIFJvbGVwbGF5FedwVDsKDQoGU3BvcnRzFZJeoDkKDwoIVGVhY2hpbmcVo7v/" +
      "OAoNCgZUcmF2ZWwVUSklOwoaChNUcm91Ymxlc2hvb3QgSXNzdWVzFWOYDDwSMAopQWN0aW9uIEV4ZWN1dGlvbiAvIERldmlj" +
      "ZSBDb250cm9sIC0gT3RoZXIVa0+XOxIfChhBZHZpY2UgJiBPcGluaW9uIC0gT3RoZXIVPM2IOBIaChNBbmFseXplIEltYWdl" +
      "IEZpbGVzFW4tFz0SFwoQQXVkaW8gR2VuZXJhdGlvbhXQnpY3EhQKDUJyYWluc3Rvcm1pbmcVhim0OBIoCiFDYXN1YWwgSW50" +
      "ZXJhY3Rpb24gLyBDaGF0IC0gT3RoZXIVwFEsPBIYChFDYXN1YWwgVG9waWMgQ2hhdBXdIIQ5EhUKDkNsYXNzaWZpY2F0aW9u" +
      "FXfhnDgSEwoMQ29kZSAtIE90aGVyFQDPnjoSFQoOQ29kZSBEZWJ1Z2dpbmcVdkUMPBIcChVDb2RlIEV4cGxhbmF0aW9uIC8g" +
      "UUEVBUJyOxIWCg9Db2RlIEdlbmVyYXRpb24VaJFdPBIOCgdDb21waWxlFRevGDsSGQoSQ29tcHJlaGVuc2lvbiAvIFFBFQit" +
      "vDwSGgoTQ29udGludWUgLyBBZGQgTW9yZRWSD546EhsKFERldmljZSAvIEFwcCBDb250cm9sFb+0mT0SEQoKRmluZCBJbWFn" +
      "ZRWj8rY4EgsKBEdhbWUVDLUMOxIRCgpJbWFnZSBFZGl0FUGM5DgSFwoQSW1hZ2UgR2VuZXJhdGlvbhWpcpk7EiIKG0ltYWdl" +
      "IFVuZGVyc3RhbmRpbmcgLSBPdGhlchVvGVs5EiQKHUluZm9ybWF0aW9uIEdhdGhlcmluZyAtIE90aGVyFY8ZojsSHQoWTWF0" +
      "aGVtYXRpY2FsIFJlYXNvbmluZxW/PIU8EhYKD01lZGlhIEV4ZWN1dGlvbhVWQXQ4EiQKHU11bHRpbW9kYWwgR2VuZXJhdGlv" +
      "biAtIE90aGVyFVHrNDoSEgoLUGVyc3BlY3RpdmUVjqYAOBIdChZQcm9jZWR1cmFsIEluc3RydWN0aW9uFW5tMjwSHQoWUHJv" +
      "b2ZyZWFkaW5nIC8gR3JhbW1hchU22cY5EhIKC1F1aXogLyBUZXN0FUqAuzsSIAoZUmVhc29uaW5nICYgR2FtZXMgLSBPdGhl" +
      "chX1eRY6EhUKDlJlY29tbWVuZGF0aW9uFdffyjkSFgoPU2hhcmUgU2VudGltZW50FfqU+zgSGgoTU2ltcGxlIFBsZWFzYW50" +
      "cmllcxXobDg7EhQKDVNpbXBsZSBTZWFyY2gVoM0VPBIkCh1TdWJqZWN0aXZlIFJld3JpdGUgLyBSZXZpc2lvbhUnx0Y7Eh0K" +
      "FlN5bnRoZXNpemUgQnJvYWQgVG9waWMVTXWcOBIUCg1UYXNrIFBsYW5uaW5nFT5x0TkSHAoVVGV4dCBBbmFseXNpcyAtIE90" +
      "aGVyFROdqzoSFgoPVGV4dCBFeHRyYWN0aW9uFTZTsDwSGQoSVGV4dCBTdW1tYXJpemF0aW9uFb1pQTsSGgoTVHJhbnNsYXRp" +
      "b24gLSBPdGhlchV2Ke45EiAKGVRyYW5zbGF0aW9uLCBFbiB0byBOb24tRW4VeLXAOhIgChlUcmFuc2xhdGlvbiwgTm9uLUVu" +
      "IHRvIEVuFa/W2TwSFwoQVmlkZW8gR2VuZXJhdGlvbhXXJjc4EhkKElZpc3VhbCBSZWZlcmVuY2luZxXdHI85EiIKG1dyaXRp" +
      "bmcgJiBSZXdyaXRpbmcgLSBPdGhlchWoUDw9EhsKFFdyaXRpbmcgRnJvbSBTY3JhdGNoFZIIDj0aEgoLT3V0cHV0IExpc3QV" +
      "jovGOhoVCg5PdXRwdXQgT3V0bGluZRWWjVk5GhMKDE91dHB1dCBUYWJsZRUgliM6GhcKEE91dHB1dCBDaXRhdGlvbnMV3c5T" +
      "OBoUCg1PdXRwdXQgRm9ybWF0FXlC2zwaFAoNQ2hhbmdlIExlbmd0aBVm/9U8GhYKD0NoYW5nZSBPcmRlcmluZxXghQw7GhcK" +
      "EENoYW5nZSBTdHJ1Y3R1cmUVxF6fOxoUCg1BZG9wdCBQZXJzb25hFRO+7joaEgoLQ2hhbmdlIFRvbmUV+aO6OhoMCgVSaHlt" +
      "ZRWq4Ac2GiIKG0NoYW5nZSB0byBTcGVjaWZpYyBBdWRpZW5jZRXI6tA5GhoKE0NoYW5nZSBUb25lIC8gU3R5bGUVoO3uOhoP" +
      "CghSZXBocmFzZRXK+Nw6GhoKE1NpbXBsaWZ5IC8gQ29uZGVuc2UVppyeOhojChxGYWN0dWFsIC8gTG9naWNhbCBDb3JyZWN0" +
      "aW9uFa2v+ToaJAodQXR0cmlidXRlLVNwZWNpZmljIENvcnJlY3Rpb24ViYcNPBodChZQdXNoYmFjayBDaXJjdW12ZW50aW9u" +
      "FWAvgjgaHgoXQ29uc3RyYWludCBSZS1TdGF0ZW1lbnQVhKGaOhoZChJFeGFjdCBSZXN1Ym1pc3Npb24VUmPuOhoZChJFeHBh" +
      "bmQgLyBFbGFib3JhdGUVKVvcOxoNCgZSZXZpc2UVCYI1OyIPCghQb3NpdGl2ZRWRSbU6Ig8KCE5lZ2F0aXZlFYeATDzaARwK" +
      "GhIYEAAaFFdvcmtpbmcgZGlyZWN0b3J5OiAvwgIQMDAwMDAwMDAwMDAwMDAwMNoCBzQgQXJnb27qApQECoEECnEI7AcSBkxv" +
      "bmdlchgFKmIKBmV4cGFuZBJWaHR0cHM6Ly9mb250cy5nc3RhdGljLmNvbS9zL2kvc2hvcnQtdGVybS9yZWxlYXNlL2dvb2ds" +
      "ZXN5bWJvbHMvZXhwYW5kL2RlZmF1bHQvMjRweC5zdmcgAQp2CO0HEgdTaG9ydGVyGAYqZgoIY29tcHJlc3MSWGh0dHBzOi8v" +
      "Zm9udHMuZ3N0YXRpYy5jb20vcy9pL3Nob3J0LXRlcm0vcmVsZWFzZS9nb29nbGVzeW1ib2xzL2NvbXByZXNzL2RlZmF1bHQv" +
      "MjRweC5zdmcgAQqbAQjrBxILUGVyc29uYWxpemUYAyqGAQoYcGVyc29uYWxfcmVjb21tZW5kYXRpb25zEmhodHRwczovL2Zv" +
      "bnRzLmdzdGF0aWMuY29tL3MvaS9zaG9ydC10ZXJtL3JlbGVhc2UvZ29vZ2xlc3ltYm9scy9wZXJzb25hbF9yZWNvbW1lbmRh" +
      "dGlvbnMvZGVmYXVsdC8yNHB4LnN2ZyABCnYI6QcSCVRyeSBhZ2FpbhgBKmQKB3JlZnJlc2gSV2h0dHBzOi8vZm9udHMuZ3N0" +
      "YXRpYy5jb20vcy9pL3Nob3J0LXRlcm0vcmVsZWFzZS9nb29nbGVzeW1ib2xzL3JlZnJlc2gvZGVmYXVsdC8yNHB4LnN2ZyAB" +
      "Eg4KCkFuc3dlciBub3cYAvgCAtgDCOADAeoDBWFyZ29u",
  }),
  Object.freeze({
    sequence: 8,
    kind: "final-answer",
    payload:
      "Eo8eCAY6ih4Khx4IARIUChJyXzAwMDAwMDAwMDAwMDAwMDAi7B0i6R0SKAoSY18wMDAwMDAwMDAwMDAwMDAwEhJyXzAwMDAw" +
      "MDAwMDAwMDAwMDAqQgoTcmNfMDAwMDAwMDAwMDAwMDAwMBIZChdXb3JraW5nIGRpcmVjdG9yeTogL2FwcEoCCAJSAmVuagJC" +
      "AOoBALICADKnAgobUkVEQUNURURfUkVHSU9OWFhYWFhYWFhYWFhYEitSRURBQ1RFRF9BRERSRVNTX0RFU0NSSVBUSU9OWFhY" +
      "WFhYWFhYWFhYWFhYGAAq2AEvL3d3dy5nb29nbGUuY29tL21hcHMvdnQvZGF0YT1BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB" +
      "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB" +
      "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB" +
      "QUFBQUFBQUFBQUFBQUFBQUFKAklEeAGiAQJlbsABAcoB1BUSBggAEAAYABoMCAAQABgAIAAoADAAIAAquRUKFwoQQWNhZGVt" +
      "aWMgLSBPdGhlchWnR705Cg0KBkNvZGluZxVbGC0+ChcKEENyZWF0aXZlIC0gT3RoZXIV/x42OQoXChBDcmVhdGl2ZSBXcml0" +
      "aW5nFZHqkjoKFwoQQ3VzdG9tZXIgU3VwcG9ydBVfHPo5CiAKGURhaWx5IExpZmUgRXhwZXJ0IC0gT3RoZXIV4FjNNwoiChtE" +
      "YWlseSBMaWZlIFBlcnNvbmFsIC0gT3RoZXIVUqDvOgoUCg1EYXRhIEFuYWx5c2lzFZBzLDsKGAoRRW1vdGlvbmFsIFN1cHBv" +
      "cnQVt78sOAoZChJFbmdhZ2VtZW50IC0gT3RoZXIVGG9VPAoNCgZFdmVudHMVbYGMOQobChRGaW5hbmNlIC8gQWNjb3VudGlu" +
      "ZxXNUu06Cg4KB0ZpdG5lc3MVgxBmOAoMCgVHYW1lcxWlDw47ChsKFEdlbmVyYWwgSW5mbyBTZWVraW5nFXbhGTwKFwoQR292" +
      "ZXJubWVudCAvIExhdxW8bYs5Ch0KFkhSIC8gQ2FyZWVyIE1hbmFnZW1lbnQVPFy3OgoNCgZIZWFsdGgVmmfxOAoVCg5MaWZl" +
      "IE9yZ2FuaXplchWr/Nc+ChgKEUxpZmVsb25nIExlYXJuaW5nFcdjazoKHgoXTWFya2V0aW5nICYgQWR2ZXJ0aXNpbmcVLPOt" +
      "OQoYChFNZWFscyAvIE51dHJpdGlvbhUXMZA4ChwKFU1lZGlhIC8gRW50ZXJ0YWlubWVudBXgqJk7ChwKFU11bHRpbW9kYWwg" +
      "R2VuZXJhdGlvbhXzjmg6ChQKDU5ld3MgLyBTdGF0dXMV6gizOgoXChBQZXJzb25hbCBGaW5hbmNlFYVwnjkKGwoUUHJvZmVz" +
      "c2lvbmFsIC0gT3RoZXIVvf/mPAogChlTYWxlcyAvIE9yZGVyIEZ1bGZpbGxtZW50FWRS/zcKEgoLU2Nob29sIFdvcmsVCykH" +
      "PgoPCghTaG9wcGluZxXGWZw4ChgKEVNvY2lhbCAvIFJvbGVwbGF5FedwVDsKDQoGU3BvcnRzFZJeoDkKDwoIVGVhY2hpbmcV" +
      "o7v/OAoNCgZUcmF2ZWwVUSklOwoaChNUcm91Ymxlc2hvb3QgSXNzdWVzFWOYDDwSMAopQWN0aW9uIEV4ZWN1dGlvbiAvIERl" +
      "dmljZSBDb250cm9sIC0gT3RoZXIVa0+XOxIfChhBZHZpY2UgJiBPcGluaW9uIC0gT3RoZXIVPM2IOBIaChNBbmFseXplIElt" +
      "YWdlIEZpbGVzFW4tFz0SFwoQQXVkaW8gR2VuZXJhdGlvbhXQnpY3EhQKDUJyYWluc3Rvcm1pbmcVhim0OBIoCiFDYXN1YWwg" +
      "SW50ZXJhY3Rpb24gLyBDaGF0IC0gT3RoZXIVwFEsPBIYChFDYXN1YWwgVG9waWMgQ2hhdBXdIIQ5EhUKDkNsYXNzaWZpY2F0" +
      "aW9uFXfhnDgSEwoMQ29kZSAtIE90aGVyFQDPnjoSFQoOQ29kZSBEZWJ1Z2dpbmcVdkUMPBIcChVDb2RlIEV4cGxhbmF0aW9u" +
      "IC8gUUEVBUJyOxIWCg9Db2RlIEdlbmVyYXRpb24VaJFdPBIOCgdDb21waWxlFRevGDsSGQoSQ29tcHJlaGVuc2lvbiAvIFFB" +
      "FQitvDwSGgoTQ29udGludWUgLyBBZGQgTW9yZRWSD546EhsKFERldmljZSAvIEFwcCBDb250cm9sFb+0mT0SEQoKRmluZCBJ" +
      "bWFnZRWj8rY4EgsKBEdhbWUVDLUMOxIRCgpJbWFnZSBFZGl0FUGM5DgSFwoQSW1hZ2UgR2VuZXJhdGlvbhWpcpk7EiIKG0lt" +
      "YWdlIFVuZGVyc3RhbmRpbmcgLSBPdGhlchVvGVs5EiQKHUluZm9ybWF0aW9uIEdhdGhlcmluZyAtIE90aGVyFY8ZojsSHQoW" +
      "TWF0aGVtYXRpY2FsIFJlYXNvbmluZxW/PIU8EhYKD01lZGlhIEV4ZWN1dGlvbhVWQXQ4EiQKHU11bHRpbW9kYWwgR2VuZXJh" +
      "dGlvbiAtIE90aGVyFVHrNDoSEgoLUGVyc3BlY3RpdmUVjqYAOBIdChZQcm9jZWR1cmFsIEluc3RydWN0aW9uFW5tMjwSHQoW" +
      "UHJvb2ZyZWFkaW5nIC8gR3JhbW1hchU22cY5EhIKC1F1aXogLyBUZXN0FUqAuzsSIAoZUmVhc29uaW5nICYgR2FtZXMgLSBP" +
      "dGhlchX1eRY6EhUKDlJlY29tbWVuZGF0aW9uFdffyjkSFgoPU2hhcmUgU2VudGltZW50FfqU+zgSGgoTU2ltcGxlIFBsZWFz" +
      "YW50cmllcxXobDg7EhQKDVNpbXBsZSBTZWFyY2gVoM0VPBIkCh1TdWJqZWN0aXZlIFJld3JpdGUgLyBSZXZpc2lvbhUnx0Y7" +
      "Eh0KFlN5bnRoZXNpemUgQnJvYWQgVG9waWMVTXWcOBIUCg1UYXNrIFBsYW5uaW5nFT5x0TkSHAoVVGV4dCBBbmFseXNpcyAt" +
      "IE90aGVyFROdqzoSFgoPVGV4dCBFeHRyYWN0aW9uFTZTsDwSGQoSVGV4dCBTdW1tYXJpemF0aW9uFb1pQTsSGgoTVHJhbnNs" +
      "YXRpb24gLSBPdGhlchV2Ke45EiAKGVRyYW5zbGF0aW9uLCBFbiB0byBOb24tRW4VeLXAOhIgChlUcmFuc2xhdGlvbiwgTm9u" +
      "LUVuIHRvIEVuFa/W2TwSFwoQVmlkZW8gR2VuZXJhdGlvbhXXJjc4EhkKElZpc3VhbCBSZWZlcmVuY2luZxXdHI85EiIKG1dy" +
      "aXRpbmcgJiBSZXdyaXRpbmcgLSBPdGhlchWoUDw9EhsKFFdyaXRpbmcgRnJvbSBTY3JhdGNoFZIIDj0aEgoLT3V0cHV0IExp" +
      "c3QVjovGOhoVCg5PdXRwdXQgT3V0bGluZRWWjVk5GhMKDE91dHB1dCBUYWJsZRUgliM6GhcKEE91dHB1dCBDaXRhdGlvbnMV" +
      "3c5TOBoUCg1PdXRwdXQgRm9ybWF0FXlC2zwaFAoNQ2hhbmdlIExlbmd0aBVm/9U8GhYKD0NoYW5nZSBPcmRlcmluZxXghQw7" +
      "GhcKEENoYW5nZSBTdHJ1Y3R1cmUVxF6fOxoUCg1BZG9wdCBQZXJzb25hFRO+7joaEgoLQ2hhbmdlIFRvbmUV+aO6OhoMCgVS" +
      "aHltZRWq4Ac2GiIKG0NoYW5nZSB0byBTcGVjaWZpYyBBdWRpZW5jZRXI6tA5GhoKE0NoYW5nZSBUb25lIC8gU3R5bGUVoO3u" +
      "OhoPCghSZXBocmFzZRXK+Nw6GhoKE1NpbXBsaWZ5IC8gQ29uZGVuc2UVppyeOhojChxGYWN0dWFsIC8gTG9naWNhbCBDb3Jy" +
      "ZWN0aW9uFa2v+ToaJAodQXR0cmlidXRlLVNwZWNpZmljIENvcnJlY3Rpb24ViYcNPBodChZQdXNoYmFjayBDaXJjdW12ZW50" +
      "aW9uFWAvgjgaHgoXQ29uc3RyYWludCBSZS1TdGF0ZW1lbnQVhKGaOhoZChJFeGFjdCBSZXN1Ym1pc3Npb24VUmPuOhoZChJF" +
      "eHBhbmQgLyBFbGFib3JhdGUVKVvcOxoNCgZSZXZpc2UVCYI1OyIPCghQb3NpdGl2ZRWRSbU6Ig8KCE5lZ2F0aXZlFYeATDza" +
      "AR8KHRIbEAAaF1dvcmtpbmcgZGlyZWN0b3J5OiAvYXBwwgIQMDAwMDAwMDAwMDAwMDAwMNoCBzQgQXJnb27qApQECoEECnEI" +
      "7AcSBkxvbmdlchgFKmIKBmV4cGFuZBJWaHR0cHM6Ly9mb250cy5nc3RhdGljLmNvbS9zL2kvc2hvcnQtdGVybS9yZWxlYXNl" +
      "L2dvb2dsZXN5bWJvbHMvZXhwYW5kL2RlZmF1bHQvMjRweC5zdmcgAQp2CO0HEgdTaG9ydGVyGAYqZgoIY29tcHJlc3MSWGh0" +
      "dHBzOi8vZm9udHMuZ3N0YXRpYy5jb20vcy9pL3Nob3J0LXRlcm0vcmVsZWFzZS9nb29nbGVzeW1ib2xzL2NvbXByZXNzL2Rl" +
      "ZmF1bHQvMjRweC5zdmcgAQqbAQjrBxILUGVyc29uYWxpemUYAyqGAQoYcGVyc29uYWxfcmVjb21tZW5kYXRpb25zEmhodHRw" +
      "czovL2ZvbnRzLmdzdGF0aWMuY29tL3MvaS9zaG9ydC10ZXJtL3JlbGVhc2UvZ29vZ2xlc3ltYm9scy9wZXJzb25hbF9yZWNv" +
      "bW1lbmRhdGlvbnMvZGVmYXVsdC8yNHB4LnN2ZyABCnYI6QcSCVRyeSBhZ2FpbhgBKmQKB3JlZnJlc2gSV2h0dHBzOi8vZm9u" +
      "dHMuZ3N0YXRpYy5jb20vcy9pL3Nob3J0LXRlcm0vcmVsZWFzZS9nb29nbGVzeW1ib2xzL3JlZnJlc2gvZGVmYXVsdC8yNHB4" +
      "LnN2ZyABEg4KCkFuc3dlciBub3cYAvgCAtgDCOADAeoDBWFyZ29ugAQD",
  }),
  Object.freeze({
    sequence: 9,
    kind: "progress-label",
    payload:
      "EnAIBzpsCmoIABIUChJyXzAwMDAwMDAwMDAwMDAwMDAiUCJOEigKEmNfMDAwMDAwMDAwMDAwMDAwMBIScl8wMDAwMDAwMDAw" +
      "MDAwMDAwWiIKIFNldHRpbmcgV29ya2luZyBEaXJlY3RvcnkgVG8gQXBw",
  }),
]);

/** Render captured records as the length-prefixed wire body Bind sends. */
export function argonBindBody(records = ARGON_BIND_RECORDS) {
  return records
    .map(({ sequence, payload }) => {
      const record = JSON.stringify([[sequence, [payload]]]);
      return `${Buffer.byteLength(record)}\n${record}\n`;
    })
    .join("");
}
