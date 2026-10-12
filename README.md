# Forge — the assistant that learns

**Forge turns "I can't do that yet" into a tested, cited new skill, in under a minute on average.**

Alexa+ already works with tens of thousands of services, but every new one waits for a partner to build, certify and ship an integration. The long tail of public data (space-station position, earthquake feeds, a dictionary, Hacker News…) never gets built.

Forge is an MCP server that lets the assistant build it itself:

> **"I can't do that yet. Give me a minute — I'll learn how."**

When no tool fits a request, Forge writes a new skill against a named public source, tests it live in a locked-down sandbox, checks the numbers in its answer against the source itself, asks the user's permission (showing exactly which sites it will reach), and installs it. Next time, it just works.

- **Learns:** a new skill in under a minute on average, even with a free model on a laptop (12/12 on our benchmark of varied requests).
- **Safe:** every run in a fresh locked-down container that can only reach the skill's declared sites; nothing installs without the user's OK.
- **Trustworthy:** every answer names its source (*"The air quality in Delhi is unhealthy, with an AQI of 164. Source: Open-Meteo."*), and numbers are cross-checked against the source before a skill is accepted. It catches the kind of mistake a model really made during our testing: a currency answer 100× too high (`scripts/crosscheck-demo.ts`).

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
- A plain `forge_capability` call answers *"I'm learning that now"* after `FORGE_WAIT_MS` (200 ms) and finishes in the background.
- **`list_capabilities`** reports progress and skills waiting for approval (*"Current Weather is ready and needs your OK. It will only access api.open-meteo.com…"*); the user says yes by voice and the assistant calls **`approve_capability`**.
- A **warm pool** of pre-started single-use sandbox runners keeps per-call overhead around 90 ms.

Clients that support tasks, elicitation and `list_changed` get the richer flow automatically.

Tested with clients other than our own:

- **Protocol 2025-03-26** (the version in the Alexa+ lifecycle docs): `scripts/e2e-protocol-2025-03-26.ts` speaks raw JSON-RPC with no SDK, no `MCP-Protocol-Version` header and no elicitation or tasks. Everything works from plain `content` text alone (that version has no `structuredContent`), including the approval id; `forge_capability` answers in ~200 ms, `list_capabilities` and `approve_capability` in under 10 ms.
- **MCP Inspector** (the official reference client): the full learn → consent → install → answer loop:

```bash
I="npx -y @modelcontextprotocol/inspector --cli http://localhost:8787/mcp --transport http"
$I --method tools/call --tool-name forge_capability --tool-arg 'request=weather in Pune'
$I --method tools/call --tool-name list_capabilities      # "... needs your OK ... (approve with id …)"
$I --method tools/call --tool-name approve_capability --tool-arg id=<id> --tool-arg approve=true
$I --method tools/call --tool-name use_skill --tool-arg name=get_current_weather --tool-arg 'input={"city":"Delhi"}'
# "It's 24 degrees in Delhi right now. Source: Open-Meteo."
```

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
| `ollama` | A local model through Ollama (`FORGE_MODEL`, e.g. `qwen2.5-coder:7b`), using the guided smith | Free development on a laptop |
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

### Two smiths

- **Agent** (default with Claude): an open-ended tool-use loop. Claude probes any public API, writes the skill and its tests, and repairs it from real failures.
- **Guided** (default with Ollama, `FORGE_SMITH=guided`): for small local models. Short steps, each constrained to a JSON schema: pick a source from the verified catalog (`src/forge/catalog.ts`), look at real responses, fill in a code template, then repair or start over based on the exact failure (located syntax errors, plain-language reasons why the answer was rejected).

Every skill must pass a live test on an example input whose answer is a real spoken sentence: no `undefined`/`NaN`, no apology, not a question, not an echo of the user's question.

`scripts/forge-bench.ts` builds 12 varied requests from scratch (weather, rain, air quality, ISS, currency, crypto, Wikipedia, Hacker News, dictionary, rocket launches, earthquakes, and one that must be refused). With `qwen2.5-coder:7b` on a laptop (RTX 3050, 4 GB) the guided smith got 12/12 in one run, about 55 s per skill.

## The demo client

`web/app.ts` is an Alexa+-style page that is itself an MCP client: it calls `forge_capability` as a task and shows the build steps live, answers the server's elicitation with a consent card, follows `tools/list_changed`, and supports voice in (Web Speech API, Chrome) and spoken answers. It is bundled by `npm run build:web` (run automatically by `npm start`).

Choosing which skill answers a request is normally the assistant's job (Alexa+ or an LLM). The demo page uses a simple keyword matcher as a stand-in.

## Safety model

Generated code is untrusted. Forge assumes it may be wrong or hostile:

- **No network in the sandbox**: every run gets a fresh container with `--network none` (plus `--read-only`, `--cap-drop ALL`, `no-new-privileges`, non-root, 256 MB, 1 CPU, 64 PIDs, no host mounts). Nothing is shared between calls.
- **Host-enforced domain allowlist**: the only way out is the runner's `fetch`, which asks Forge on the host (`src/sandbox/relay.ts`). Forge checks the skill's declared domains on every redirect hop, refuses any name that resolves to this machine or a private network (no SSRF to local services such as Ollama), and caps requests (50) and response size (5 MB) per run.
- **Static checks** before anything runs (no imports, `require`, `process`, `eval`, `new Function` or Node built-ins, also through comments). These catch honest mistakes early; the network-less container is the actual boundary.
- **Time limits** per call and per test run.
- **Human consent** before any skill is installed, showing exactly which sites it will access.
- **Answers you can check**: every answer names its source, and for numeric sources the live test cross-checks the numbers in the answer against the source itself (a hand-written reference check per source). This catches skills that read or compute a value wrongly, e.g. a currency conversion applied twice.
- **No secrets**: skills only use keyless public sources. Requests that need a login, payment or private data are declined.

`scripts/sandbox-security.ts` (part of `npm test`) attacks the sandbox like a hostile skill would: loading Node's network modules directly, raw IP addresses, sites off the allowlist, redirects to other sites, names that resolve to 127.0.0.1, and request floods. All must fail.

Known limitation: a skill's tests run inside its own sandbox, so deliberately hostile code could fake its own test results. That can't get it past the network boundary or the user's consent (which shows exactly which sites it will reach); moving test evaluation out of the sandbox is on the roadmap.

`FORGE_SANDBOX=process` runs code in a separate Node process instead of Docker. It is a development fallback only, not an isolation boundary.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | HTTP port |
| `FORGE_PROVIDER` | `anthropic` | `anthropic`, `bedrock`, `ollama` or `mock` |
| `FORGE_MODEL` | per provider | Model id (`claude-opus-5-5`, `anthropic.claude-opus-5-5`, `qwen2.5:3b`) |
| `FORGE_SMITH` | `agent` (`guided` with Ollama) | Which smith builds skills |
| `OLLAMA_CONTEXT` | `8192` | Context window requested from Ollama |
| `AWS_REGION` | `us-east-1` | Bedrock region |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama endpoint |
| `FORGE_SANDBOX` | `docker` | `docker` or `process` (dev only) |
| `FORGE_SANDBOX_IMAGE` | `node:20-alpine` | Sandbox image |
| `FORGE_WARM_POOL` | `2` | Pre-started sandbox runners |
| `FORGE_WAIT_MS` | `200` | How long a plain `forge_capability` call waits before answering "learning" (`Infinity` to wait for the result) |
| `FORGE_MAX_SUBMISSIONS` | `4` | Attempts the Smith gets to pass its tests |
| `FORGE_MAX_TURNS` | `16` | Model turns per build |
| `FORGE_TOOL_TIMEOUT_MS` | `15000` | Time limit per skill call |
| `FORGE_DATA_DIR` | `data` | Where learned skills are stored |
| `FORGE_DEBUG` | — | `1` prints raw model turns |

## Tests

```bash
npm test                          # sandbox security attacks + the three end-to-end suites below
npx tsx scripts/sandbox-security.ts # hostile-skill escape attempts; all must fail
npx tsx scripts/e2e-tasks.ts      # task flow + Alexa-style flow against the mock smith (12 checks)
npx tsx scripts/e2e-hotplug.ts    # approve -> tools/list_changed -> call -> remove
npx tsx scripts/e2e-protocol-2025-03-26.ts  # an older-protocol client with no SDK, text only
npx tsx scripts/sandbox-smoke.ts  # sandbox: live fetch allowed, other domains blocked
npx tsx scripts/sandbox-latency.ts
npx tsx scripts/forge-bench.ts    # smith reliability on 12 requests (needs a real provider)
npx tsx scripts/crosscheck-demo.ts  # the cross-check rejecting a skill whose number is wrong
```

## Project layout

```
src/
  index.ts            HTTP server: Streamable HTTP sessions, demo client, /health
  server.ts           MCP server: tools, task, elicitation, resources
  forge/smith.ts      the agent loop that researches, writes, tests and repairs a skill
  forge/guided.ts     the guided smith for small local models
  forge/catalog.ts    verified keyless public APIs
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
- Working on a local model: the guided smith (see `scripts/forge-bench.ts`).
- In progress: the agent smith on Claude, deployment on AWS, and an Alexa+ add-on.
- Known gap for a real Alexa+ add-on: certification. Alexa+ policy rejects open-ended text inputs and tools unrelated to an add-on's stated purpose, and skills generated after certification would need their own review. A realistic path is Forge as a developer tool: skills are learned, reviewed by a person, then shipped as ordinary certified add-ons.

## License

[MIT](LICENSE)
