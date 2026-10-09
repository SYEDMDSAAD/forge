# Friction log

Entries recorded while building Forge. Severity: Blocker / High / Medium / Low.

## 1. Finding which MCP SDK release supports spec 2025-11-25
- **Task:** Start an MCP server that negotiates protocol 2025-11-25 over Streamable HTTP.
- **Steps:** Read the hackathon rules → modelcontextprotocol.io → npm `@modelcontextprotocol/sdk`.
- **Expected:** Docs state which SDK version implements which spec revision.
- **Actual:** Had to grep `LATEST_PROTOCOL_VERSION` inside `node_modules` (1.32.1 → `2025-11-25`) to confirm.
- **Severity:** Low
- **Workaround:** Inspected the installed package; verified the negotiated version with a client (`scripts/e2e-hotplug.ts`).
- **Suggestion:** Add an "SDK version ↔ spec revision" table to the Alexa+ hackathon resources page.

## 2. Elicitation from inside an MCP task hangs plain tool calls (TypeScript SDK 1.32.1)
- **Task:** Run a 30-120 s tool as an MCP task (`taskSupport: "optional"`) and ask the user for consent (elicitation) before it finishes.
- **Steps:** `registerToolTask` → in the task's background work, `extra.sendRequest(elicitation/create, …, { relatedTask: { taskId } })`, the pattern used in the SDK's own `taskLifecycle.test.ts`.
- **Expected:** Works for task-aware clients and for clients that make a plain `tools/call` (the SDK polls the task for them).
- **Actual:** Task-aware clients worked. Plain calls hung until they timed out: the request is queued for `tasks/result`, which a plain client never calls. Also, `extra.sendRequest`'s options type omits `relatedTask`, so the documented pattern needs `as unknown as TaskRequestOptions` (the SDK's tests do the same).
- **Severity:** Medium
- **Workaround:** Detect task-augmented calls from the raw HTTP body (`markTaskCall()` in `src/index.ts`) and elicit directly on plain calls; covered by `scripts/e2e-tasks.ts`.
- **Suggestion:** Fixed upstream in our PR: https://github.com/modelcontextprotocol/typescript-sdk/pull/2974 (send task-related requests directly when the call wasn't task-augmented; includes a regression test). Also allow `relatedTask` in `TaskRequestOptions` so the documented pattern type-checks.

## 3. Alexa+ MCP Toolkit: which client features and limits apply is unclear
- **Task:** Plan an Alexa+ add-on around MCP spec 2025-11-25 features (dynamic tool lists, elicitation, tasks).
- **Steps:** Read the MCP Toolkit overview and quickstart on developer.amazon.com.
- **Expected:** A table of which client features Alexa+ supports (tools/list_changed, elicitation, tasks, progress, sampling) and what the latency limit applies to.
- **Actual:** "Alexa+ refreshes tool information only on deployment" means runtime tool changes are ignored, which only shows up in the quickstart checklist. Elicitation, tasks and progress aren't mentioned at all. "Round-trip query response latency of less than 500 ms" doesn't say whether it covers each tools/call, and many real tools that call public APIs can't meet it. The OAuth 2.1 checklist is marked "Required" without saying whether add-ons without user accounts need it. The toolkit is US-only, which isn't stated on the hackathon page.
- **Severity:** High (it changed the architecture)
- **Workaround:** Fixed tool surface (`use_skill`, `list_capabilities`); forge_capability answers "learning" within ~400ms and finishes in the background; voice consent via `approve_capability` when the client can't elicit; warm sandbox pool.
- **Suggestion:** Publish a client-capabilities matrix for Alexa+, clarify the latency rule per MCP method, and list supported countries on the hackathon page.

## 4. Ollama silently runs models with a 4,096-token context (Ollama 0.30.8)
- **Task:** Use a local model (`qwen2.5-coder:7b`) through Ollama's Anthropic-compatible endpoint to write tools.
- **Steps:** Pointed the Anthropic SDK at `http://localhost:11434`, sent our system prompt, tool schemas and API responses.
- **Expected:** The model's own (much larger) context window, or an error when the prompt doesn't fit.
- **Actual:** `ollama ps` showed `CONTEXT 4096`. Longer prompts were cut without any error, so the model was working from truncated instructions. We found no way to raise it through the Anthropic-compatible endpoint.
- **Severity:** High (silent; looked like the model was simply bad)
- **Workaround:** Switched to Ollama's native `/api/chat`, which accepts `options.num_ctx` (we use 8192).
- **Suggestion:** Warn or error when a request is truncated, and accept a context-size option on the compatible endpoints.

## 5. Tool calls returned as plain text through Ollama's Anthropic-compatible endpoint
- **Task:** Let a local coder model call our tools (`http_probe`, `submit_tool`) in an agent loop.
- **Steps:** Same Anthropic-SDK agent loop that targets Claude, pointed at Ollama with `qwen2.5-coder:7b`.
- **Expected:** `tool_use` content blocks.
- **Actual:** The model wrote the calls as JSON inside a markdown code block in a `text` block, so the loop never saw a tool call and ran out of turns (10 minutes, no result). `qwen2.5:3b` did emit real tool calls, but sometimes with empty arguments.
- **Severity:** Medium (may depend on the model's chat template)
- **Workaround:** A separate "guided" mode for small models: Ollama's native API with `format` (JSON-schema-constrained output) and short steps instead of tool calling. 12/12 on our benchmark in the latest run.
- **Suggestion:** Document which models' templates support tool calling on the compatible endpoint, or fall back to parsing JSON tool calls from text.

## 6. ~25% of `fetch` calls failed with an unexplained "fetch failed" (Node.js 20.20.2)
- **Task:** Call public APIs (open-meteo.com) from the sandbox, from a home connection in India.
- **Steps:** Plain `fetch()` inside a `node:20-alpine` container; repeated 20 identical requests.
- **Expected:** All succeed (curl from the same machine always did, in ~0.8 s).
- **Actual:** 5 of 20 failed with `TypeError: fetch failed`. The reason (`ETIMEDOUT`) is only in `error.cause`. Node's default `autoSelectFamilyAttemptTimeout` gives each IPv6/IPv4 connection attempt 250 ms, which a high-latency link exceeds.
- **Severity:** High (a quarter of live demo calls would have failed)
- **Workaround:** `net.setDefaultAutoSelectFamilyAttemptTimeout(2000)` in the sandbox runner (20/20 after), and we now surface `error.cause` in tool errors.
- **Suggestion:** Include the cause in fetch's error message, and use a larger default attempt timeout.

## 7. MCP Tasks (2025-11-25) are on the SDK's v1 line only
- **Task:** Contribute a fix for the task bug in entry #2.
- **Steps:** Cloned `modelcontextprotocol/typescript-sdk` `main`, looked for `registerToolTask`.
- **Expected:** The current SDK to implement the spec's Tasks.
- **Actual:** `main` is v2, which removed the 2025-11 experimental Tasks (PR #2128) in favour of a separate extension; the code we use lives on `v1.x`, which only takes small fixes. Not obvious from the README or npm.
- **Severity:** Low
- **Workaround:** Based the fix on `v1.x`.
- **Suggestion:** A short "Tasks support by SDK version" note in the README and the Tasks docs.
