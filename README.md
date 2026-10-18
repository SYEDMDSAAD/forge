# Forge — the assistant that learns

**Forge turns "I can't do that yet" into a tested, cited new skill, in under a minute on average.**

Alexa+ already works with tens of thousands of services, but every new one waits for a partner to build, certify and ship an integration. The long tail of public data (space-station position, earthquake feeds, a dictionary, Hacker News…) never gets built.

Forge is an MCP server that lets the assistant build it itself:

> **"I can't do that yet. Give me a minute — I'll learn how."**

When no tool fits a request, Forge writes a new skill against a named public source, tests it live in a locked-down sandbox on the user's own question, checks its answer against the source itself, and gives the user that answer right away. Then it asks whether to keep the skill (showing exactly which sites it will reach). Next time, it answers instantly.

- **Learns:** a new skill in under a minute on average, even with a free model on a laptop (12/12 on our core benchmark; 63/72 on 24 new wordings, with all 18 unsafe requests refused).
- **Safe:** every run in a fresh locked-down container that can only reach the skill's declared sites; nothing installs without the user's OK.
- **Trustworthy:** every answer names its source (*"The air quality in Delhi is unhealthy, with an AQI of 164. Source: Open-Meteo."*), and its numbers (or, for news, its headlines) are cross-checked against the source before a skill is accepted. It catches the kind of mistake a model really made during our testing: a currency answer 100× too high (`scripts/crosscheck-demo.ts`).

```
user request ─▶ forge_capability ─▶ Smith (local model or Claude)
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
- **The user hears back without asking.** When a background build finishes, the news rides along with the next answer from any Forge tool, answer included (*"Also tell the user: I've learned how to answer "what's the weather in Pune": It's 23 degrees in Pune right now. Source: Open-Meteo. Should I keep this skill…"*), once per session, so a voice assistant that only reads tool results still passes it on. Connected clients are also told at once with an MCP log notice (`level: "notice"`, `data.stage: "skill_ready"` or `"skill_failed"`); the demo page speaks the answer and asks whether to keep the skill. (A true push to an Echo device would go through Alexa's own notifications, which MCP add-ons can't send today.)
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

- **Agent** (default with Claude): an open-ended tool-use loop. Claude probes any public API, writes the skill and its tests, and repairs it from real failures. It is implemented but not yet run end to end (this project was built at zero cost; every result in this README comes from the guided smith on a free local model).
- **Guided** (default with Ollama, `FORGE_SMITH=guided`): for small local models. Short steps, each constrained to a JSON schema: pick a source from the verified catalog (`src/forge/catalog.ts`), look at real responses, fill in a code template, then repair or start over based on the exact failure (located syntax errors, plain-language reasons why the answer was rejected).

Every skill must pass a live test on an example input whose answer is a real spoken sentence: no `undefined`/`NaN`, no apology, not a question, not an echo of the user's question.

`scripts/forge-bench.ts` builds requests from scratch with `qwen2.5-coder:7b` on a laptop (RTX 3050, 4 GB). Results are saved in `bench/`.

- **Core set** (12 requests: weather, rain, air quality, ISS, currency, crypto, Wikipedia, Hacker News, dictionary, rocket launches, earthquakes, and one that must be refused): 12/12, about 49 s per skill.
- **Large set** (`--large --runs=3`: 24 new wordings across all 11 sources, plus 6 requests that need a login, payment or private data), 90 builds: 81/90 as expected. All 18 unsafe requests were refused; 63/72 skills built (52 on the first attempt); 48 s mean, 46 s median, 137 s slowest.
- **Answers checked by hand.** "Built" isn't "right", so we read every answer. 6 of the 63 built skills gave wrong answers: "no holidays found" for Germany (3×), a broken US-holiday skill (1×), and an earthquake in another country reported for "Japan" (2×). The 9 misses were refusals, not wrong installs; 6 of them were our own cross-check wrongly assuming rupees for a dollar crypto answer.
- **After fixing both** (an answer that says "nothing found", "error" or "invalid" on a valid example now fails the test; the crypto check accepts dollars, rupees and euros), the 5 weakest requests × 3 runs: crypto 6/6 built and correct; holidays turned from wrong answers into correct ones or safe refusals. One known limit remains: the earthquake skill doesn't always filter by country (2 of 3 runs answered with a quake elsewhere). The cross-check verifies numbers, not whether a filter was applied.

### Real-time data

Skills answer from live public APIs, fetched when the user asks: 12 verified, keyless sources in `src/forge/catalog.ts` (weather, air quality, the ISS, currency rates, crypto prices, Wikipedia, news, Hacker News, a dictionary, rocket launches, earthquakes, public holidays). The demo page lists them under **How it works**; any MCP client can read the `forge://sources` resource. Requests outside them are declined rather than guessed.

News comes from Google News search (RSS), so a question like *"What car model has Elon Musk launched recently?"* gets today's headlines with their publishers. A small model reads XML poorly, so the catalog gives it a short parsing recipe, and the cross-check re-reads the very feed the skill fetched: the answer must quote one of its headlines. On the three news requests in `--large`, over the last two benchmarks (two runs each, 12 builds): 11 built, every answer real, current headlines with their publishers, and 1 refused after its retries; no wrong answers (`bench/large-2026-10-18T0807.json`, `…T0818.json`). Those builds sometimes fixed the topic in the code: a skill learned for Elon Musk's car, named `get_latest_launches`, later answered *"When is the next rocket launch?"* with car news. So the news source now always makes one general skill, `get_news(topic)`, with the user's topic as its test example, and the cross-check rejects a skill that searches for anything but its topic input. After that change all three news requests built `get_news` (`bench/large-2026-10-18T1002.json`), and later news questions reuse it without learning anything new. The two runs before these fixes are kept in `bench/` too: one built skills that said "Unknown headline" (now caught as placeholder text and by the headline check), the other failed on quote marks in the recipe. Google News feeds are offered for personal, non-commercial use; a published add-on would use a licensed news API instead (GDELT, the free alternative we tried, rate-limited every request from our network).

## From learned skill to certifiable add-on

Alexa+ certification rejects open-ended tools, and code generated after certification would need its own review. So Forge can hand a learned skill over as an ordinary, standalone MCP server that a person reviews and ships like any hand-written integration:

```bash
npx tsx scripts/export-skill.ts                      # list learned skills
npx tsx scripts/export-skill.ts convert_currency     # -> exports/convert_currency/
cd exports/convert_currency && npm install && npm test && npm start
```

The folder has no dependency on Forge, a model or a sandbox:

- `skill.mjs`: the code Forge wrote, unchanged (the file to review);
- `lib.mjs`: a `fetch` limited to the skill's declared sites (on every redirect), the answer clean-up, source citation and cross-check;
- `server.mjs`: a stateless Streamable HTTP MCP server with exactly one read-only tool and its fixed input schema;
- `test.mjs`: the skill's live tests and source cross-check, flagging answers slower than 500 ms;
- `forge-export.json` (definition and provenance: request, attempts, test results), `Dockerfile`, and a `README.md` with a review checklist (code, tests, the source's terms of use, latency, personal data, HTTPS).

`scripts/export-check.ts` (part of `npm test`) exports a skill and runs the result on its own: its tests pass with the cross-check, its server lists one tool and answers with the source, wrong input is rejected and undeclared sites are refused.

## The demo client

`web/app.ts` is an Alexa+-style page that is itself an MCP client: it calls `forge_capability` as a task and shows the build steps live, answers the server's elicitation with a consent card, follows `tools/list_changed`, and supports voice in (Web Speech API, Chrome) and spoken answers. It is bundled by `npm run build:web` (run automatically by `npm start`).

Choosing which skill answers a request is the assistant's job (Alexa+ or an LLM reading the tool list), not Forge's. The demo page plays that role with a model (`src/assistant.ts`): it offers the learned skills to Claude as real tools, or asks the local model to pick one and fill in its inputs (each step constrained to a JSON schema, with "none" meaning "learn a new skill"). The page shows which skill was picked, with what inputs, and how long it took. In mock mode it falls back to a keyword matcher.

Everything Forge did is on the page. While it learns, a card shows four steps (find a source, write the code, test and cross-check, your OK) and the side panel the full log: which source it chose and why, the tool it designed, every attempt and repair, what the live test asked and answered, and what the cross-check compared. **How it works** (top right) explains the process, lists the models on the laptop and every verified live source (the `forge://sources` MCP resource). Clicking a learned skill, or **How I got this** under an answer, opens its record from the `forge://capabilities/{name}` resource: the original request, inputs, the source and the sites it may reach, the live test and its answer, the cross-check values, the URLs it called, and the code it wrote.

The page speaks with a natural neural voice, [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M) (82M parameters, Apache-2.0), which the Forge server runs on the CPU (`src/voice.ts`, a 330 MB download the first time; full precision is twice as fast as the quantized model on a CPU). Pick from five voices next to "Speak answers". Answers are spoken one sentence at a time, the next made while the current one plays, so speech starts in about 1 s. Until the voice has loaded, or with `FORGE_VOICE=0`, the page uses the browser's best built-in voice. On Alexa+, Alexa speaks Forge's answers in its own voice.

`scripts/router-check.ts` asks 18 paraphrased requests against 11 skills ("Do I need an umbrella in Mumbai?", "How many rupees is 250 dollars?", "Book me a cab"...), and 6 more when only a weather skill exists, the state early in a demo, when a small model is tempted to use it for anything nearby ("What's the air quality in Delhi?"). So the local model checks each pick with a yes/no question ("does this skill give exactly what was asked?") and, if it says no, picks once more without that skill. Three more cases offer only a currency converter, where crypto prices look like conversions, and three only a news skill, which must not answer "When is the next rocket launch?" (that's a schedule, learned from the launch source); each skill's original question ("Convert 100 US dollars to rupees") is shown to the model as an example. With `qwen2.5-coder:7b` it routes 29/30 correctly, about 3.6 s per request, including unit conversion (`dollars` → `USD`) and noticing a missing city. Misses are safe ones that vary between runs, for example "Who was Ada Lovelace?" learns a new skill instead of using the Wikipedia one, and "How much is one ethereum worth in dollars?" picks the currency converter but then asks for the amount rather than answering wrongly.

## Safety model

Generated code is untrusted. Forge assumes it may be wrong or hostile:

- **No network in the sandbox**: every run gets a fresh container with `--network none` (plus `--read-only`, `--cap-drop ALL`, `no-new-privileges`, non-root, 256 MB, 1 CPU, 64 PIDs, no host mounts). Nothing is shared between calls.
- **Host-enforced domain allowlist**: the only way out is the runner's `fetch`, which asks Forge on the host (`src/sandbox/relay.ts`). Forge checks the skill's declared domains on every redirect hop, refuses any name that resolves to this machine or a private network (no SSRF to local services such as Ollama), and caps requests (50) and response size (5 MB) per run.
- **Static checks** before anything runs (no imports, `require`, `process`, `eval`, `new Function` or Node built-ins, also through comments). These catch honest mistakes early; the network-less container is the actual boundary.
- **Time limits** per call and per test run.
- **Busy sources**: a GET that gets 429/502/503/504 is retried twice with a short pause; if the source is still down, the user hears that in plain words (*"Open-Meteo isn't answering right now (the service is overloaded). Try again in a minute."*) instead of an error.
- **Response cache** (in the relay, for plain GETs): a reply is reused while the source says it's fresh (its `Cache-Control`; 10 minutes for Open-Meteo and The Space Devs, which send none; never for sources that say `no-cache`, like the ISS position). Repeat questions skip the source (~70 ms instead of ~1 s). When a source is down, a skill in real use can answer from its last good reply up to 2 hours old, and the answer says so: *"…Source: Open-Meteo. Open-Meteo isn't responding, so that's from 14 minutes ago."* Skills being built and tested never get old data. `FORGE_CACHE=0` turns it off.
- **Answer first, then consent.** The live test runs the new skill on the user's own question in the sandbox, and its cross-checked answer is given right away; the skill itself is installed only if the user says yes, after seeing exactly which sites it will access. Saying no still leaves the user with their answer. (Clients get the answer in the elicitation's `_meta["forge/answer"]`, in the `skill_ready` notice, and in the tool result.)
- **Answers you can check**: every answer names its source, and the live test cross-checks the answer against the source itself with a hand-written reference check per source: the numbers must match (this catches a value read or computed wrongly, e.g. a currency conversion applied twice), and a news answer must quote a headline from the very feed the skill read (this catches an answer the model made up, and a skill that ignores its topic and reads some other feed: `scripts/news-check.ts`).
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
| `FORGE_CACHE` | on | `0` disables the response cache |
| `FORGE_CACHE_MAX_STALE_MS` | `7200000` | Oldest reply used when a source is down (2 hours) |
| `FORGE_VOICE` | `1` | `0` turns off the demo page's natural voice (it then uses the browser's voice) |
| `FORGE_DATA_DIR` | `data` | Where learned skills are stored |
| `FORGE_DEBUG` | — | `1` prints raw model turns |

## Tests

```bash
npm test                          # sandbox security attacks, the three end-to-end suites, the cache and export checks below
npx tsx scripts/sandbox-security.ts # hostile-skill escape attempts; all must fail
npx tsx scripts/e2e-tasks.ts      # task flow + Alexa-style flow against the mock smith (12 checks)
npx tsx scripts/e2e-hotplug.ts    # approve -> tools/list_changed -> call -> remove
npx tsx scripts/e2e-protocol-2025-03-26.ts  # an older-protocol client with no SDK, text only
npx tsx scripts/cache-check.ts    # fresh replies reused, no-cache respected, down sources answered with their age
npx tsx scripts/news-check.ts     # a news answer must quote a headline from the feed the skill read
npx tsx scripts/export-check.ts   # an exported skill runs on its own: tests, one-tool server, allowlist
npx tsx scripts/sandbox-smoke.ts  # sandbox: live fetch allowed, other domains blocked
npx tsx scripts/sandbox-latency.ts
npx tsx scripts/forge-bench.ts    # smith reliability on 12 requests (needs a real provider)
npx tsx scripts/crosscheck-demo.ts  # the cross-check rejecting a skill whose number is wrong
npx tsx scripts/router-check.ts   # the demo page's skill routing on 27 paraphrased requests (needs a real provider)
```

## Project layout

```
src/
  index.ts            HTTP server: Streamable HTTP sessions, demo client, /health
  assistant.ts        the demo page's assistant brain: which skill answers a request (not part of the MCP server)
  voice.ts            the demo page's natural voice (Kokoro on the CPU; not part of the MCP server)
  server.ts           MCP server: tools, task, elicitation, resources
  forge/smith.ts      the agent loop that researches, writes, tests and repairs a skill
  forge/guided.ts     the guided smith for small local models
  forge/catalog.ts    verified keyless public APIs
  forge/validate.ts   static checks on generated code
  forge/registry.ts   persisted skills, shared by all sessions
  forge/export.ts     a learned skill as a standalone MCP server folder, for review
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
- Written but not yet run: the agent smith on Claude (API or Bedrock). Not done: deployment on AWS, and a published Alexa+ add-on.
- Known gap for a real Alexa+ add-on: certification. Alexa+ policy rejects open-ended text inputs and tools unrelated to an add-on's stated purpose, and skills generated after certification would need their own review. A realistic path is Forge as a developer tool: skills are learned, reviewed by a person, then shipped as ordinary certified add-ons. `scripts/export-skill.ts` does the hand-over (see above).

## License

[MIT](LICENSE)
