# Forge — the assistant that learns

Every voice assistant has a long tail of requests it can't handle: *"Is my train late?"*, *"Read me the new posts on my college notice board"*, *"What's the air quality where I am?"* Today the answer is "Sorry, I can't help with that."

Forge is an MCP server for Alexa+ that changes the answer to:

> **"I can't do that yet. Give me a minute — I'll learn how."**

When no tool fits a request, Forge has Claude write a new tool, runs it in a locked-down sandbox against the real internet until its tests pass, asks the user's permission, and installs it. The next time, *"Is my train late?"* just works.

```
user request ─▶ forge_capability ─▶ Smith (Claude)
                                     │  probe real APIs
                                     │  write tool + tests
                                     ▼
                                  Sandbox (one-shot container, domain allowlist)
                                     │  run tests live; on failure, Smith repairs (≤4 tries)
                                     ▼
                              consent: "It will only access api.open-meteo.com. Install?"
                                     ▼
                              Registry (persisted) ─▶ new MCP tool + use_skill
```

## How it uses MCP (spec 2025-11-25, Streamable HTTP)

| Feature | What Forge does with it |
|---|---|
| **Tools** | `forge_capability`, `use_skill`, `list_capabilities`, `approve_capability`, `remove_capability`, plus one tool per learned skill |
| **`tools/list_changed`** | Learned skills are registered at runtime and announced to every connected session |
| **Tasks** | `forge_capability` runs as a task (`taskSupport: "optional"`): task-aware clients get an id at once and live status ("Running 2 live tests in the sandbox") |
| **Elicitation** | Consent before a skill is installed, sent from inside the running task; skill details travel in `_meta` so clients can render a card |
| **Resources** | `forge://capabilities/{name}` exposes every learned skill's source, tests and test results |
| **Logging / progress** | Build steps stream as log messages and progress notifications |

### Alexa+ compatibility

Alexa+ reads the tool list only at deployment and expects answers in under 500 ms ([MCP Toolkit quickstart](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-quickstart.html)). So Forge never needs a new tool to be visible to work:

- **`use_skill(name, input)`** runs any learned skill through a fixed tool surface.
- A plain `forge_capability` call answers *"I'm learning that now"* after `FORGE_WAIT_MS` (400 ms) and finishes in the background.
- **`list_capabilities`** reports progress and skills waiting for approval (*"Current Weather is ready and needs your OK. It will only access api.open-meteo.com…"*); the user says yes by voice and the assistant calls **`approve_capability`**.
- A **warm pool** of pre-started single-use sandbox runners keeps per-call overhead around 90 ms.

Clients that support tasks, elicitation and `list_changed` get the richer flow automatically.

## Quick start

Requirements: Node.js 20+, Docker (for the sandbox).

```bash
npm install
cp .env.example .env   # then pick a provider (below)
npm start              # MCP server at http://localhost:8787/mcp, demo client at http://localhost:8787/
```

### Providers

| `FORGE_PROVIDER` | What builds skills | Use for |
|---|---|---|
| `bedrock` | Claude on Amazon Bedrock (`AWS_REGION`, standard AWS credentials) | Deployment |
| `anthropic` | Claude API (`ANTHROPIC_API_KEY`) | Development |
| `ollama` | A local model through Ollama's Anthropic-compatible API (`FORGE_MODEL`, default `qwen2.5:3b`) | Free plumbing tests; small models can't build skills reliably |
| `mock` | Replays one known-good build (a weather skill); its tests still run for real | UI work and demo fallback, no model needed |

Try it without any model:

```bash
FORGE_PROVIDER=mock npm start
# open http://localhost:8787 and ask "What's the weather in Pune right now?"
```

Build a skill from the command line (needs a real provider):

```bash
npx tsx scripts/forge-cli.ts "Where is the ISS right now?"
```

### Connecting an MCP client

Point any Streamable HTTP MCP client at `http://localhost:8787/mcp`. To reach it from Alexa+ during development, expose it through a tunnel (for example `cloudflared tunnel --url http://localhost:8787`).

## The demo client

`web/app.ts` is an Alexa+-style page that is itself an MCP client: it calls `forge_capability` as a task and shows the build steps live, answers the server's elicitation with a consent card, follows `tools/list_changed`, and supports voice in (Web Speech API, Chrome) and spoken answers. It is bundled by `npm run build:web` (run automatically by `npm start`).

Choosing which skill answers a request is normally the assistant's job (Alexa+ or an LLM). The demo page uses a simple keyword matcher as a stand-in.

## Safety model

Generated code is untrusted. Forge assumes it may be wrong or hostile:

- **Static checks** before anything runs: no imports, `require`, `process`, `eval`, `new Function` or Node built-ins; size limits; a valid input schema.
- **One-shot containers**: every run gets a fresh container (`--read-only`, `--cap-drop ALL`, `no-new-privileges`, non-root, 256 MB, 1 CPU, 64 PIDs, no host mounts). Nothing is shared between calls.
- **Per-skill domain allowlist**: tool code never sees the real `fetch`; requests to hosts outside the skill's declared domains throw.
- **Time limits** per call and per test run.
- **Human consent** before any skill is installed, showing exactly which sites it will access.
- **No secrets**: skills only use keyless public sources. Requests that need a login, payment or private data are declined.

`FORGE_SANDBOX=process` runs code in a separate Node process instead of Docker. It is a development fallback only, not an isolation boundary.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | HTTP port |
| `FORGE_PROVIDER` | `anthropic` | `anthropic`, `bedrock`, `ollama` or `mock` |
| `FORGE_MODEL` | per provider | Model id (`claude-opus-5-5`, `anthropic.claude-opus-5-5`, `qwen2.5:3b`) |
| `AWS_REGION` | `us-east-1` | Bedrock region |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama endpoint |
| `FORGE_SANDBOX` | `docker` | `docker` or `process` (dev only) |
| `FORGE_SANDBOX_IMAGE` | `node:20-alpine` | Sandbox image |
| `FORGE_WARM_POOL` | `2` | Pre-started sandbox runners |
| `FORGE_WAIT_MS` | `400` | How long a plain `forge_capability` call waits before answering "learning" (`Infinity` to wait for the result) |
| `FORGE_MAX_SUBMISSIONS` | `4` | Attempts the Smith gets to pass its tests |
| `FORGE_MAX_TURNS` | `16` | Model turns per build |
| `FORGE_TOOL_TIMEOUT_MS` | `15000` | Time limit per skill call |
| `FORGE_DATA_DIR` | `data` | Where learned skills are stored |
| `FORGE_DEBUG` | — | `1` prints raw model turns |

## Tests

```bash
npm test                          # both end-to-end suites below
npx tsx scripts/e2e-tasks.ts      # task flow + Alexa-style flow against the mock smith (12 checks)
npx tsx scripts/e2e-hotplug.ts    # approve -> tools/list_changed -> call -> remove
npx tsx scripts/sandbox-smoke.ts  # sandbox: live fetch allowed, other domains blocked
npx tsx scripts/sandbox-latency.ts
```

## Project layout

```
src/
  index.ts            HTTP server: Streamable HTTP sessions, demo client, /health
  server.ts           MCP server: tools, task, elicitation, resources
  forge/smith.ts      the agent loop that researches, writes, tests and repairs a skill
  forge/validate.ts   static checks on generated code
  forge/registry.ts   persisted skills, shared by all sessions
  forge/mock.ts       replay provider
  sandbox/sandbox.ts  container runner + warm pool
  sandbox/runner.mjs  code that runs inside the sandbox (fetch allowlist, tests)
  llm.ts, config.ts
web/                  demo client
scripts/              CLI and end-to-end tests
FRICTION_LOG.md       issues hit while building on the Amazon and MCP tooling
```

## Status

Built for the Build, Ship, Shape: Amazon Developer Hackathon (Alexa+ track).

- Working and tested: the MCP server, sandbox, runtime tool registration, tasks, elicitation, the Alexa-compatible flow and the demo client.
- In progress: tuning the Smith on Claude across varied requests, deployment on AWS, and an Alexa+ add-on.

## License

[MIT](LICENSE)
