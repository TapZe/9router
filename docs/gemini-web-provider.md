# Gemini Web App provider (`gemini-web`)

New 9router provider that talks to [gemini.google.com](https://gemini.google.com/app) the same way the BardChatUi web app does. It is **not** `gemini` (AI Studio API key), **not** `gemini-cli` (Cloud Code OAuth), and **not** `antigravity` / `ag`.

Auth matches existing webCookie providers (`grok-web`, `perplexity-web`): paste the browser `Cookie` header from gemini.google.com. No Google API key.

Evidence: REA Playwright capture `ev_e79cc02f…` (anonymous ping) and logged-in Brave CDP `ev_71823d10…` (2026-10-14). Logged-in `ping` on Argon → HTTP 200 StreamGenerate → `Pong! What's on your mind?`

## Cookie sessions and account names

The current implementation uses native Gemini Web requests for chat and images. The protocol captures below are historical observations, not a static model catalog.

Manage Gemini Web accounts through the cookie-session panel on the chat or image provider page. A cookie session stores one full Cookie header. Each linked account selects a Google slot such as `/u/0/` or `/u/2/`. The root `/app` selection is distinct from an explicit slot zero.

During verification, 9router reads the active account's email from the authenticated bootstrap page. New accounts use the Google account-menu display name only when the menu email matches that active email. Otherwise they use the active email. This does not make an extra profile request. If Google omits the identity, the existing session-and-slot label fallback remains.

The cookie-session name is a separate label for the shared browser login. Adding slots or replacing cookies preserves existing account names, including names you edited. You can rename an individual account in its account settings.

Deleting an account removes its routable slot, not the saved cookie session. An empty session offers **Reconnect accounts**. Enter its Google slot numbers and choose a proxy setting. 9router verifies the slots with the stored cookie header, so no cookie paste is needed. **Delete** removes an empty saved session when you no longer want its cookies retained.

Dashboard model tests give Gemini Web chat 330 seconds for bootstrap and generation. Image tests allow another 120 seconds for download. These deadlines come from the native request limits. Other providers keep their existing 15-second test deadline.

Identity fields follow Google's private web format and can change. The selected-account email field is also used by [pi-web-access](https://github.com/nicobailon/pi-web-access/blob/main/gemini-web.ts). A missing name does not make a working cookie session invalid.

Cookie headers grant access to the Google session. Paste them only into the local session form. Session responses do not return cookie values. Function tools, video, music, Canvas, and Deep Research are not supported.

### Saving cookies on a server

Use HTTPS when opening the dashboard over a network. The cookie-paste dialog sends the header to your 9router server; copying it in the browser alone does not verify or save it.

Gemini session changes require a same-origin dashboard request. The guard recognizes the request URL, the incoming Host with its request scheme, and configured `BASE_URL` or `NEXT_PUBLIC_BASE_URL` origins. Browser `Sec-Fetch-Site: same-origin` metadata also supports reverse proxies that rewrite the internal host or terminate TLS. Forwarded host headers alone do not grant access.

An older build may report `Gemini Web mutation origin is not allowed` when its configured URL is still localhost. Set the server's `BASE_URL` to the exact dashboard origin, including its scheme and port, and restart as a workaround. The repaired guard accepts genuine same-origin dashboard requests without requiring that workaround. Cross-site requests and cookie-authenticated requests without Origin or Referer remain rejected.

For older browsers without Fetch Metadata, a proxy that rewrites Host to an internal address still needs `BASE_URL` set to the public dashboard origin. Keep both configured base URLs aligned with this deployment.

## Observed routing

| Piece | Observation |
|---|---|
| App | `GET https://gemini.google.com/app` |
| Catalog RPC | `POST https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=otAQ7b&source-path=%2Fapp&bl={cfb2h}&f.sid={FdrFJe}&hl=en-US&_reqid={n}&rt=c` |
| Chat RPC | `POST https://gemini.google.com{eptZe}data/assistant.lamda.BardFrontendService/StreamGenerate?bl={cfb2h}&f.sid={FdrFJe}&hl=en&pageId=none&_reqid={n}&rt=c` |
| Body | `application/x-www-form-urlencoded` fields `f.req` and, when logged in, `at={SNlM0e}` |
| Catalog rpcid | `otAQ7b` with `f.req = [[["otAQ7b","[1]",null,"generic"]]]` |
| Stream rpcid (JS) | `RxAFq` = `/BardFrontendService.StreamGenerate` = `/assistant.lamda.BardFrontendService/StreamGenerate` |
| Alternate logged-in path (JS, **not used** in the working capture) | `POST https://geminiweb-pa.clients6.google.com/v1/conversations:streamGenerate?alt=sse` with `X-Goog-Api-Key` (`d2zJAe`), `Authorization: SAPISIDHASH …`, `credentials: include` |
| WIZ bootstrap | HTML `AF_initDataCallback`: `cfb2h` = `bl`, `FdrFJe` = `f.sid`, `eptZe` = `/_/BardChatUi/` |
| Response | `)]}'` then length-prefixed `wrb.fr` JSON chunks |

## Model picker (`otAQ7b`)

Anonymous catalog `inner[24][1]` (and default `inner[0] = 6`, default hex `cf41b0e0dd7d53e5`):

| Picker label | Subtitle | Mode int (`n1`) | 9router model id |
|---|---|---|---|
| Flash-Lite | Fastest answers / 3.5 Flash-Lite | 6 | `gemini-web-flash-lite` |
| Flash | All-around help / 3.6 Flash | 1 | `gemini-web-flash` |
| Thinking | Solves complex problems / 3.6 Thinking | 5 | `gemini-web-thinking` |
| Pro | Advanced reasoning / 3.1 Pro | 3 | `gemini-web-pro` |
| Argon | Complex tasks / 4 Argon | 8 | `gemini-web-argon` |

Mode int is written to StreamGenerate inner slot **79** (observed `6` on the Flash-Lite ping). Hex ids for Flash/Pro/Thinking/Argon were **not** present on the anonymous picker; do not invent them.

## StreamGenerate payload

`f.req = JSON.stringify([null, JSON.stringify(inner)])` where `inner` is a 99-slot array.

Anonymous `ping` (`ev_e79cc02f`, Flash-Lite mode 6) vs logged-in follow-up (`ev_71823d`, Argon mode 8 on `/u/5/app/e90e0045d4244658`):

| Slot | Anonymous | Logged-in Argon follow-up |
|---|---|---|
| `[0]` | `["ping", 0, null…]` | same |
| `[1]` | `["en-US"]` | `["en"]` |
| `[3]` | `!sb…` ~1548 chars | `!WV…` 1559 chars (JS/WAA; **not** in HTML) |
| `[4]` | 32-char hex | 32-char hex |
| `[6]` | `[0]` | `[1]` |
| `[17]` | `[[0]]` | `[[1]]` |
| `[41]` | `[2]` | `[1]` |
| `[59]` | UUID | UUID |
| `[67]` | unset | `0` |
| `[68]` | `1` | `2` |
| `[71]` | unset | `["c_e90e0045d4244658", null, …, ""]` conversation id |
| `[79]` | `6` | `8` (Argon) |
| `[80]` | unset | `1` |
| `[91]` | `0` | `1` |

Executor v1 sends a **new chat** (no `[71]` replay). `[3]` is omitted (`null`) because the generator is not in HTML. Extra form field `at=` is `SNlM0e` from `/app` HTML when present.

Reply text path in `wrb.fr` inner JSON: `[4][0][1][0]`. Conversation ids: `[1] = ["c_…", "r_…"]`. Model label in later chunks: `inner[42] = "4 Argon"`, `inner[58] = 8`.

## Auth / login

Logged-in capture cookies are hashed only (26 fingerprints). Values were not copied into chat. `SNlM0e` (`at=`) **is** in `/app` HTML (`AF_initDataCallback`). `eptZe` = `/u/5/_/BardChatUi/` for account 5.

9router login follows **grok-web cookie paste**:

1. User opens gemini.google.com (signed in).
2. DevTools → Network → any `BardChatUi` request → copy `Cookie`.
3. Paste into 9router `gemini-web` connection (`authType: cookie`).

Anonymous COMPASS/NID still worked for Flash-Lite without `at=`. Logged-in StreamGenerate **did** send `at=`. geminiweb-pa / SAPISIDHASH was **not** used on the working send.

## 9router wiring (same as grok-web)

1. `open-sse/providers/registry/gemini-web.js` — `category: "webCookie"`, `authType: "cookie"`.
2. `open-sse/executors/gemini-web.js` — `GeminiWebExecutor` extends `BaseExecutor`.
3. Register in `open-sse/executors/index.js` and `open-sse/providers/registry/index.js`.
4. Cookie probe in `src/app/api/providers/validate/route.js` and `src/app/api/providers/[id]/test/testUtils.js` via `otAQ7b` (401/403 = bad cookie).
5. Placeholder in `AddApiKeyModal.js`.
6. Tests: `SPECIALIZED` + `web-cookie-validation` + alias/providers baselines.

Do **not** reuse `gemini` / `gemini-cli` / `antigravity` executors or translators. Format is `gemini-web` (custom executor, OpenAI in/out like grok-web).

## Executor algorithm

1. Flatten OpenAI messages like grok-web (`parseOpenAIMessages`).
2. `GET /app` with Cookie (no POST Content-Type) → extract `cfb2h`, `FdrFJe`, `SNlM0e`, `eptZe`. Fail if bl/sid missing.
3. `POST {eptZe}…/StreamGenerate` with `f.req` + `at=` when `SNlM0e` exists. `inner[79] = mode`. Fresh `[4]` hex and `[59]` UUID. `[3]` left null.
4. Parse `wrb.fr` by buffering across TCP chunks (declared length ≠ payload.length by 2 on this capture). Fail HTTP 200 with no reply text / rpcerror.
5. Emit OpenAI SSE / JSON.

Multi-turn: flatten history into one prompt. Do not replay `c_` / `r_` until a dedicated new-chat vs follow-up matrix is captured.

## Harness proof (2026-10-14, stored `gemini-web` cookie)

Needed for a coding harness: OpenAI `tools` → `tool_calls`, plus thinking/`reasoning_content`. Measured, not assumed.

| Claim | Result | Evidence |
|---|---|---|
| Text chat | **PASS** | Flash-Lite `ping` → `Pong! How can I help you today?` (2.7s). Structured 3-line prompt → `1. pong / 2. 2026 / 3. Earth` (9.8s). |
| Cookie + `at=` | **PASS** | 19 cookie pairs including `__Secure-1PSID`. StreamGenerate body had `at=`. Path `/_/BardChatUi/…/StreamGenerate`. |
| Model id → upstream model | **FAIL** | `gemini-web-thinking` (slot 79=5), `gemini-web-pro` (3), `gemini-web-argon` (8) all returned wrb.fr `inner[42]="3.5 Flash-Lite"` and `inner[58]=6`. Logged-in extras (`[6]=[1]`, `[17]=[[1]`, `[41]=[1]`, `[68]=2`, `[80]=1`, `[91]=1`) still Flash-Lite. |
| Catalog hex as `[39]` | **FAIL** | Flash `56fdd199312815e2`, Pro `e6fa609c3fa255c0`, Argon `95a4c0abcba24364` in `[39]` → HTTP 400 (~140ms). Hex in `[4]` accepted but still Flash-Lite. |
| Thinking / `reasoning_content` | **FAIL** | Catalog `otAQ7b` inner `[24]` is now per-model **Thinking level** Low=1 / Medium=4 / High=2 (not a 5th picker model). Executor `isThinking` is unused. No `reasoning_content` in OpenAI output. Thinking-prompt reply was assistant **text** (and a `python?code_reference` fence), still labeled Flash-Lite. |
| OpenAI `tools` / `tool_calls` | **FAIL** | `get_time` was on the 9router body. `parseOpenAIMessages` dropped it. StreamGenerate `[0][0]` was only the user string. Reply was Tokyo wall-clock text, `finish_reason=stop`, no `tool_calls`. grok-web also has no tool_calls path. |
| Google hosted “Sources” | catalog only | `otAQ7b` inner `[19]`: Search, Gmail, Drive, Chat, Files. Not client function-calling. Slot for enabling them on StreamGenerate **not captured**. |
| UI StreamGenerate selector | **unproven** | REA connect `ev_75ed559c…` typed into the Gemini textbox + Enter; no `StreamGenerate` URL in that capture (Quill Enter did not send). Prior working send `ev_71823d10` was an Argon **follow-up** with `[71]=c_…` and `[79]=8`. |

Logged-in catalog models (`otAQ7b` inner `[15]`, hex at `[0]`, mode int at `[17]`):

| Label | Hex | Mode int | 9router id today |
|---|---|---|---|
| 3.5 Flash-Lite | `8c46e95b1a07cecc` | 6 | `gemini-web-flash-lite` (this is what every new-chat actually ran) |
| 3.8 Flash | `56fdd199312815e2` | 1 | `gemini-web-flash` |
| 3.1 Pro | `e6fa609c3fa255c0` | 3 | `gemini-web-pro` |
| 4 Argon | `95a4c0abcba24364` | 8 | `gemini-web-argon` |

There is **no** catalog row named Thinking. Default catalog `[0]=1` (Flash).

**Harness verdict:** do not point OMP / a tool-using agent at `gmw/*` yet. Text-only chat through Flash-Lite works. Tools, thinking tokens, and model routing do not.

To make those real, capture (do not invent):

1. A **new-chat** UI send after picking Flash / Pro / Argon — occupied StreamGenerate slots vs Flash-Lite template (especially wherever the catalog hex lands; `[39]` is wrong).
2. Same model with Thinking level High vs Low — which slot carries `1/4/2`, and which wrb.fr cells are thoughts vs answer.
3. A send with a Google Source (Search or code) on — whether that is `[30]` / `[61]` or something else.
4. Only after (1)–(3): whether BardChatUi can take **client** function declarations at all. If not, a harness needs `gemini` / `gemini-cli` / `antigravity`, not this cookie provider.

## Unknowns (do not fake)

- Generator for slot `[3]` (`!sb…` / `!WV…`). WAA `Create` returns a JS blob, not this string.
- Which StreamGenerate slot selects catalog hex / thinking level on a **new** chat. `[79]` is ignored; `[39]` 400s.
- `x-goog-ext-*-jspb` header **values** (names observed on the logged-in send).
- Client `tools` → `tool_calls` mapping (not present on grok-web either; Gemini Web catalog only lists Google Sources).
- Whether omitting `[3]` 400s on a **new** logged-in chat that also selects a non-default model.

## Verification

- Unit: cookie prefix strip + `otAQ7b` 401/403 vs 200.
- Golden: `gemini-web` in `SPECIALIZED` (custom executor).
- Alias baseline: `gmw` → `gemini-web`.
- Live text: stored cookie, `gemini-web-flash-lite` `ping` and a 3-line prompt — HTTP 200 with reply text.
- Live harness gaps: model ids collapse to Flash-Lite; `tools` dropped; no `reasoning_content`.
