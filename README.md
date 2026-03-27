# Hollow

**Web perception for AI agents. Through math, not pixels.**

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![npm](https://img.shields.io/badge/npm-hollow--sdk-red.svg)](https://npmjs.com/package/hollow-sdk)
[![PyPI](https://img.shields.io/badge/PyPI-hollow--sdk-blue.svg)](https://pypi.org/project/hollow-sdk/)
[![MCP](https://img.shields.io/badge/MCP-hollow--mcp-purple.svg)](https://npmjs.com/package/hollow-mcp)

---

The standard way to give an AI agent a browser is to run a real browser — headless Chrome, Puppeteer, a BaaS provider — and either take screenshots for a vision model or dump the DOM so the model can parse it.

Both approaches were designed for humans. Screenshots because humans see. DOM dumps because humans read HTML. Neither was designed for the question an AI agent actually needs answered: **what is on this page, where is it, and what can I do with it?**

Hollow answers that question differently. It strips the browser down to the one step that produces spatial information — layout calculation — and runs that as a serverless function. No rendering. No pixels. No running machine.

```bash
curl -X POST https://hollow-tan-omega.vercel.app/api/perceive \
  -H "Content-Type: application/json" \
  -d '{"url": "https://news.ycombinator.com"}'
```

```json
{
  "sessionId": "sess:abc123",
  "gdgMap": "[Viewport: 1280x800]\n\n[nav: flex-row y:0 h:44]\n  [1] a \"new\"   x:0  w:24\n  [2] a \"past\"  x:24 w:28\n  [3] a \"comments\" x:52 w:64\n...",
  "confidence": 1.00,
  "tier": "hollow"
}
```

The agent reads the map. Decides. Acts. The function terminates. Nothing idles.

---

## Try it
**[hollow-tan-omega.vercel.app/mirror](https://hollow-tan-omega.vercel.app/mirror)**

Matrix Mirror is the observability UI — a macOS desktop environment where Hollow is the only application. Type any URL, watch it load in the Ghost DOM, see every element tagged and addressable, watch every routing decision in the agent log.

Scan the QR code from any active session. Paste the system prompt into Claude, GPT, or Gemini. Working browser in 30 seconds. No API key. No setup.

![Matrix Mirror showing startpage loaded in the Ghost DOM](https://raw.githubusercontent.com/Badgerion/hollow/main/assets/Mirror-v2-1.png)
![Matrix Mirror showing Hacker News loaded in the Matrix Mirror with element badges, PARTIAL tier, 0.35 confidence](https://raw.githubusercontent.com/Badgerion/hollow/main/assets/Mirror-v2-3)

---

## The problem with the current approach

Every existing tool for AI browser agents carries the weight of a human browser:

**Screenshots + vision models** — the agent sees the page the way a human does, which means the model spends tokens describing what things look like instead of reasoning about what they are. Slow. Expensive. Brittle on dense UIs.

**Headless Chrome / Puppeteer / BaaS** — a real browser process running on a real machine. 300MB binary, 2–4 second cold starts, a persistent server to maintain. The browser was built to sit in front of screens. Running it headlessly is a good option, but not purpose built for cash and compute efficiency.

**Raw HTML / curl + parser** — fast and cheap, but JavaScript-rendered content doesn't exist in raw HTML. Most modern sites are applications, not documents. curl gets you an empty div on any React SPA.

---

## What Hollow does instead

A browser pipeline has two separable concerns: **layout** (where things are) and **painting** (how things look — requires a GPU and a screen).

Hollow keeps the layout step and drops everything after it.

It uses Happy DOM to execute JavaScript and build the DOM tree, then Yoga — the same layout engine that powers React Native — to calculate exact coordinates for every element. The result is a structured spatial tree called a [Graphical Density Grounding](https://github.com/Badgerion/GDG-browser) Spatial map: element IDs, positions, relationships. Everything an agent needs to reason and act and nothing it doesn't.

```
[Viewport: 1280x800]

[nav: flex-row y:0 h:44]
  [1] a "Home"          x:0    w:80   h:44
  [2] a "Login"         x:80   w:80   h:44

[main: flex-col y:44]
  [3] input:email       x:40   y:84   w:400  h:44
  [4] button "Submit"   x:40   y:140  w:400  h:48
```

No GPU. No screen. No process. A serverless function that runs, calculates, and terminates.

---



## Not every site needs the same approach

For sites where standard DOM parsing isn't enough, Hollow has a routing engine that picks the right approach automatically:

| Tier | How | When |
|------|-----|------|
| **HOLLOW** | Happy DOM + Yoga layout | Most of the web |
| **VDOM** | React Fiber tree extraction | SPAs that don't need to render |
| **TEXT** | Direct extraction | Text-heavy pages — HN, Reddit, docs |
| **CACHE** | Wayback Machine / Bing | WAF-blocked or paywalled sites |
| **MOBILE** | iOS/Android API | Twitter/X, Reddit, Spotify |
| **PARTIAL** | Graceful degradation | Everything else |

Coverage is ~90–95% of agent tasks. The remaining 5–10% — hardware-verified WAFs, sites requiring proof of a real GPU — route to a human checkpoint. Those are almost always tasks that warrant human sign-off anyway.

---

## See it working

**[hollow-tan-omega.vercel.app/mirror](https://hollow-tan-omega.vercel.app/mirror)**

![Matrix Mirror — Ghost DOM view showing Startpage rendered in the Mirror iframe, with TEXT tier, 0.95 confidence, and session ID in the top bar](https://raw.githubusercontent.com/Badgerion/hollow/main/assets/Mirror-v2-2.png)

![Matrix Mirror — Hacker News loaded with TEXT tier, numbered element badges, 0.95 confidence, and live SSE pipeline log](https://raw.githubusercontent.com/Badgerion/hollow/main/assets/mirror-ghost-dom.png)

The Matrix Mirror is the observability UI. Type any URL, watch it load, see every element tagged and addressable. The agent log shows every routing decision, confidence score, and action in real time.

An AI agent ran 15 steps across 4 concurrent browser tabs — summarised a Hacker News comment thread, compared Reddit and HN simultaneously. 9/10 benchmark tasks completed.

Scan the QR code from any active session. Paste the system prompt into Claude, GPT, or Gemini. It has a working browser in 5 seconds. No API key. No setup.

---

## SDKs and integrations

| Package | Install | Description |
|---------|---------|-------------|
| **[hollow-sdk](https://npmjs.com/package/hollow-sdk)** | `npm install hollow-sdk` | TypeScript/Node SDK |
| **[hollow-sdk](https://pypi.org/project/hollow-sdk/)** | `pip install hollow-sdk` | Python SDK |
| **[hollow-mcp](https://npmjs.com/package/hollow-mcp)** | `npx hollow-mcp` | MCP server for Claude Desktop |


---
## Integrations

### Claude Desktop (MCP)

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "hollow": {
      "command": "npx",
      "args": ["hollow-mcp"]
    }
  }
}
```

Restart Claude Desktop. Claude gets `hollow_perceive`, `hollow_act`, `hollow_session_get`, and `hollow_session_close` as native tools.

### TypeScript / Node

```bash
npm install hollow-sdk
```

```typescript
import { HollowClient, runAgent, AnthropicAdapter } from 'hollow-sdk'

const hollow = new HollowClient()

// Single page
const page = await hollow.perceive('https://news.ycombinator.com')
console.log(page.gdgMap)

// Agent task — works with any model
const result = await runAgent(hollow, {
  task: 'What are the top 3 stories on HN right now?',
  model: new AnthropicAdapter(),   // or OpenAIAdapter, or your own
  onStep: (step) => console.log(`Step ${step.step}: ${step.tier}`)
})
console.log(result)
```

### Python

```bash
pip install hollow-sdk
```

```python
from hollow import HollowClient, run_agent, AnthropicAdapter

client = HollowClient()

# Single page
page = client.perceive('https://news.ycombinator.com')
print(page.gdg_map)

# Agent task
result = run_agent(
  client,
  task='What are the top 3 stories on HN right now?',
  model=AnthropicAdapter(),   # or OpenAIAdapter, or your own
  on_step=lambda s: print(f'Step {s.step}: {s.tier}')
)
print(result)
```

### Any AI via system prompt

Paste this into any AI that supports HTTP tool calls:

```
You have access to Hollow, a serverless web intelligence layer.
Endpoint: https://hollow-tan-omega.vercel.app

To load a page:
POST /api/perceive { "url": "https://..." }
→ returns sessionId, gdgMap, confidence, tier

To interact:
POST /api/act { "sessionId": "sess:...", "action": { "type": "click", "elementId": 3 } }
Action types: navigate, click, fill, scroll, select, hover

Element IDs like [1], [2] in the gdgMap are actionable.
Start at https://www.startpage.com when you need to search.
```

---

## API

**POST /api/perceive** — load a page, start or resume a session

```json
{ "url": "https://...", "sessionId": "optional", "stateId": "optional" }
→ { "sessionId", "gdgMap", "confidence", "tier", "jsErrors" }
```

**POST /api/act** — interact with the current page

```json
{
  "sessionId": "sess:abc123",
  "action": { "type": "click", "elementId": 3 },
  "intervention": "optional human instruction"
}
→ { "sessionId", "gdgMap", "confidence", "tier" }
```

**GET /mirror** — Matrix Mirror observability UI

**GET /api/stream/:sessionId** — SSE event stream

**GET /api/session/:sessionId** — current session state

**DELETE /session/:sessionId** — close session, free Redis state

`stateId` is the Hydra inlet — an optional hook for injecting cookies, auth tokens, and localStorage before the pipeline runs.

---

## Deploy your own

```bash
git clone https://github.com/Badgerion/hollow
cd hollow && npm install
```

```env
UPSTASH_REDIS_REST_URL=your_url
UPSTASH_REDIS_REST_TOKEN=your_token
```

```bash
vercel deploy
```

No binaries. No Docker. No Chromium. A standard Next.js deploy. Sessions stored in Upstash Redis with automatic TTL expiry.

---

## Contributing

Most valuable right now:
- Happy DOM polyfills — each one expands native coverage
- Mobile API registry — client profiles for more platforms
- WebSocket Skills — sync schemas for real-time apps

---

## License

Apache 2.0 for personal use, research, open source, and internal business use. Reach out if you need a commercial license.
