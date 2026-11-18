# Gemini Web provider

`gemini-web`, also available as `gweb`, uses an authenticated Gemini website session for native chat and image requests. It is separate from the `gemini`, `gemini-cli`, and `antigravity` providers. You do not supply a Google API key. The protocol reads Gemini's public website API consumer key from its live bootstrap.

## Terms

| Term | Meaning |
|---|---|
| Cookie session | One stored Google cookie jar shared by its linked accounts. |
| Account slot | A selected Google account within that jar, such as `/u/0/` or `/u/2/`. The default `/app` account is distinct from explicit slot zero. |
| Account catalog | Models verified for one account slot. Names and availability come from Google, not a fixed global Gemini Web list. |
| Generation dispatch | The request that can consume a model turn. Opening an Argon Bind channel is preparation, not generation dispatch. |

## Add and reconnect accounts

Open Gemini Web on the dashboard's chat or image provider page. Use its cookie-session panel rather than the generic API-key dialog.

For cookie paste:

1. Sign in at [gemini.google.com](https://gemini.google.com/app).
2. Copy the complete Cookie header from an authenticated request in the browser's Network panel.
3. Paste the header into a new session, choose the Google account slots to save, and select their proxy setting.
4. Save. 9router verifies each requested slot before storing the session and its account rows.

For browser capture:

1. Open the browser flow from the session panel and sign in to every Google account you need in the shared profile.
2. Capture the shared cookie jar once. A signed-in Gemini tab can be selected for reference.
3. Check the account slots to save. This field chooses the saved accounts; the selected tab only identifies the capture source.
4. Use the explicit save action to verify and commit those slots. Status polling does not save a Gemini capture. Cancel discards an uncommitted capture.

Verification names new account rows from the active account's email, using the matching account-menu display name when available. If Google supplies no identity, 9router uses the session-and-slot label. Replacing cookies or adding slots preserves names you edited. The cookie-session name is a separate label and can be renamed without contacting Google.

Deleting an account removes its routable slot, not its saved cookie session. Use **Reconnect accounts** on an empty session to verify and reattach slots with the stored cookies. Delete an empty session when its cookie jar is no longer needed.

## Models and request controls

Use the ids returned by `/v1/models` or the selected account's model list. The provider prefix is `gemini-web/` or `gweb/`; `gmw` is not an alias. Old fixed names such as `gemini-web-flash-lite` are not a current model catalog.

The account catalog selects the exact model. A missing or ambiguous model returns an error instead of silently substituting another model. The transport follows what each surface can carry, never the model's hex id, because that id is fetched per account and changes whenever Google republishes its catalog. Text-only chat uses ProcessSession Bind, which reports the turn's own completion flags; input images and image-generation tasks use StreamGenerate, whose payload carries the upload and generated-media slots. Policy-code models such as Code & analysis are published only inside the channel's own model group, so they stay on ProcessSession even when the bootstrap key is missing: that case returns the explicit preparation error instead of sending an unverified request. Because that surface carries no uploaded-file slot, a policy-code chat turn with an image is refused with a 400 before an upload is spent, rather than answered without the image. Any other model falls back to StreamGenerate without that key. The image endpoint uses `gemini-image`. Progress labels and answer text have separate protocol fields.

The ProcessSession channel-open request declares that bootstrap key and `application/x-protobuf` in its `$httpHeaders` tunnel. Missing consumer identity is rejected before a turn is sent. The receive poll starts before the turn POST, and heartbeat-only polls resume with the last acknowledged sequence on the same channel. The turn is posted once, with one deadline covering channel open, send, and all receive polls. Google channel-status errors retain their code and message rather than becoming an empty-answer error.

Chat supports OpenAI-shaped JSON and SSE responses. Message history is flattened into the native prompt. PNG, JPEG, and WebP image input must use validated data URLs. Generated images are downloaded from allowed Google media hosts and validated before returning their bytes.

Google's thought summaries appear as `reasoning_content`. Supported effort levels are `low`, `medium`, and `high`. Disabling thinking or requesting a token budget is rejected. Explicit client controls take precedence over provider defaults and are checked before translation can normalize them.

### Tool calling

Gemini Web has no function calling of its own, so OpenAI function tools go through a prompt bridge ported from [gemini-web-to-api](https://github.com/ntthanh2603/gemini-web-to-api). Clients in other formats, such as Claude, work too, because their tools are translated to OpenAI tools first.

- When a request has `tools` and `tool_choice` is not `none`, the prompt lists each tool's name, description, and parameter schema. It asks Gemini to reply with JSON only: `{"tool_calls":[{"name":...,"arguments":{...}}]}` or `{"content":"..."}`.
- The reply is parsed into OpenAI `tool_calls` with `finish_reason: "tool_calls"`, or into normal text. The parser accepts code fences, text around the JSON, raw newlines inside strings, and the keys `args`, `parameters`, and `input`. Calls to tools that were not declared, or to a tool other than the one `tool_choice` names, are dropped. Arguments must be a JSON object that sets every required property of the tool's schema.
- `tool_choice` supports `auto`, `none`, `required`, and `{"type":"function","function":{"name":...}}`. With `none`, the tools are left out of the prompt.
- 9router never makes up a call. If a reply cannot be used, Gemini is asked again with the reason, up to three turns in total. Then the request fails with 502 and code `gemini_web_invalid_tool_call`. Every attempt is a separate turn on the account. An empty answer, such as `{"content":""}`, fails with 502, as an empty plain answer does.
- Earlier tool calls and tool results in the history are written into the prompt as `[Call Tool: name with ID id and Input: args]` and `[Tool Result for ID id]: result`. The whole history is sent on every turn.
- With tools on, the reply is read in full before it is returned, because a tool call is known only once the JSON is complete. Streaming clients then get the reasoning, the tool calls or text, and the finish chunk together.
- A tool that is not a named function tool, a forced tool name that was not declared, and the legacy `functions` field are rejected with 400 before any Google request.

This depends on Gemini following the JSON format. It is less reliable than native function calling, especially with many or complex tools.

### JSON mode (`response_format`)

Gemini Web has no JSON mode, so `response_format` is best-effort, ported from gemini-web-to-api (#110).

- `{"type":"json_object"}` asks for one JSON object. `{"type":"json_schema","json_schema":{"schema":{...}}}` asks for a value that matches the schema. `text`, unknown types, and a missing field change nothing.
- The prompt asks for JSON only. The reply is checked: a code fence and prose around the JSON are removed. `json_object` needs an object. `json_schema` needs the schema's top-level `type` and its `required` keys; nothing deeper is checked, and a schema that cannot be read only needs valid JSON.
- An unusable reply is asked for once more, with the reason. If that reply is still unusable, or the repair turn fails, the first reply is returned as it came, with a warning in the log. The repair is one more turn on the account.
- With tools, the tool bridge prompt carries the rule instead: a text reply puts the JSON itself in `content`. A tool call is returned as is and skips JSON mode. A repair is one turn, and a tool call in it is not used.
- The reply is read in full before it is returned, also for streaming clients. Generated image links are left out when there is JSON text, because they would break it.
- Only OpenAI chat clients can ask for it. Claude, Gemini, and Responses clients have no field that 9router translates into `response_format`.

Video, music, Canvas, and Deep Research are not supported.

## Session updates and errors

Existing-session updates require the positive-integer `expectedRevision` returned by the latest session read. This includes renaming, adding slots, and replacing cookies. A stale revision returns 409 without overwriting a newer cookie jar. Creating a new session does not require a revision.

Adding slots to an existing session requires an explicit proxy setting. A selected pool must exist and be usable before verification starts; an unknown pool is not a request for direct access.

Invalid cookies, slots, revisions, and unsupported controls return 400. Disallowed mutation origins return 403. Unknown sessions return 404. Revision or membership conflicts return 409. An inconclusive probe is unverified, not proof of a bad cookie, and uses 503. Client cancellation uses 499.

A generation that may already have been consumed is not replayed on another account or combo member after an ambiguous failure. Failures before generation dispatch remain eligible for normal fallback. This policy is distinct from account cooldowns and caller cancellation.

## Transport and security

Cookie headers grant access to the Google session. Save them only on a 9router server you trust. Use HTTPS when accessing that server over a network. Session responses omit cookie values and authentication tokens.

Gemini mutations require a same-origin dashboard request. The guard considers the request URL, incoming Host and scheme, and configured `BASE_URL` or `NEXT_PUBLIC_BASE_URL`. Browser-controlled `Sec-Fetch-Site: same-origin` supports TLS-terminating proxies. Forwarded host headers alone do not grant access. Keep configured base URLs aligned with the public dashboard origin for older browsers without Fetch Metadata.

The native transport always verifies TLS certificates. Direct and SOCKS requests use the native HTTP/1 adapter; HTTP CONNECT and relay requests use the shared transport. Gemini's explicit response-header limit must be honored on each path. A relay runtime can impose its own upstream limits independently.

Input media is restricted to validated data URLs. Upload URLs, generated-image URLs, and redirects are checked before credentials or downloads are sent. Cookie rotation uses revision checks, and successful attempts that return no new cookie do not trigger a rotation on every generation.

## Implementation and verification

- `src/lib/geminiWebAccounts.js` owns session/account operations and public projections.
- `src/lib/db/repos/geminiWebSessionsRepo.js` owns transactional cookie jars, membership, and revisions.
- `src/app/api/providers/gemini-web/sessions/` exposes session CRUD. Browser capture uses `src/app/api/providers/web-login/route.js`.
- `src/lib/mutationOrigin.js` supplies the shared dashboard mutation-origin guard. Denials use `mutation_origin_denied` with status 403.
- `open-sse/executors/gemini-web.js` owns native execution. Its sibling directory contains bootstrap, catalog, protocol, Bind, media, session, and transport code.
- `probeGeminiWebConnection` performs authenticated bootstrap and GetUserStatus checks. The provider test routes call it through `testUtils.js`; the generic validate route is not the Gemini verification path.

Dashboard model tests allow 330 seconds for Gemini chat bootstrap and generation, with another 120 seconds for image download. Other providers retain their existing test deadline.

Run the unit suites from `tests/` with Vitest. Database suites must use their disposable fixtures, and transport suites use loopback servers and synthetic credentials. A live Google test is separate evidence and requires explicit authorization; an offline passing suite does not establish live upstream compatibility.

Google's private web protocol can change. Historical October 2026 captures in this document's Git history describe the older implementation, not current aliases, model ids, supported controls, or a live compatibility guarantee.
