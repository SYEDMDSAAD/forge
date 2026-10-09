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

## 2. Elicitation from inside an MCP task (TypeScript SDK 1.32.1)
- **Task:** Run a 30-120s tool as an MCP task and ask the user for consent (elicitation) before it finishes.
- **Steps:** `registerToolTask` with `taskSupport: "optional"` → in the background work, call `extra.sendRequest(elicitation/create, …, { relatedTask })`.
- **Expected:** A documented way to elicit from inside a task, and a way for `createTask` to know whether the client actually sent a task-augmented call.
- **Actual:** `extra.sendRequest`'s options type omits `relatedTask` (compile error). Had to call `server.request(..., { relatedTask })` and set `input_required` manually. `createTask` runs for both task and auto-polled plain calls with no flag to tell them apart, and a related-task elicitation on a plain call is never delivered (the auto-poller doesn't call `tasks/result`), so the call hangs. Worked around by inspecting `params.task` on the raw HTTP body.
- **Severity:** Medium
- **Workaround:** `markTaskCall()` in `src/index.ts`; two delivery paths in `src/server.ts`; covered by `scripts/e2e-tasks.ts`.
- **Suggestion:** Expose `isTaskRequest` on the `createTask` extra, and let `extra.sendRequest` route to the task queue only when the call was task-augmented.

## 3. Alexa+ MCP Toolkit: which client features and limits apply is unclear
- **Task:** Plan an Alexa+ add-on around MCP spec 2025-11-25 features (dynamic tool lists, elicitation, tasks).
- **Steps:** Read the MCP Toolkit overview and quickstart on developer.amazon.com.
- **Expected:** A table of which client features Alexa+ supports (tools/list_changed, elicitation, tasks, progress, sampling) and what the latency limit applies to.
- **Actual:** "Alexa+ refreshes tool information only on deployment" means runtime tool changes are ignored, which only shows up in the quickstart checklist. Elicitation, tasks and progress aren't mentioned at all. "Round-trip query response latency of less than 500 ms" doesn't say whether it covers each tools/call, and many real tools that call public APIs can't meet it. The OAuth 2.1 checklist is marked "Required" without saying whether add-ons without user accounts need it. The toolkit is US-only, which isn't stated on the hackathon page.
- **Severity:** High (it changed the architecture)
- **Workaround:** Fixed tool surface (`use_skill`, `list_capabilities`); forge_capability answers "learning" within ~400ms and finishes in the background; voice consent via `approve_capability` when the client can't elicit; warm sandbox pool.
- **Suggestion:** Publish a client-capabilities matrix for Alexa+, clarify the latency rule per MCP method, and list supported countries on the hackathon page.
