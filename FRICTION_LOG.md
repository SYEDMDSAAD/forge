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
