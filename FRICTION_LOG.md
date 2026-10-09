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
