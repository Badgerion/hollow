# Hollow

**Web perception for AI agents. Through math, not pixels.**

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Live](https://img.shields.io/badge/live-hollow--tan--omega.vercel.app-teal.svg)](https://hollow-tan-omega.vercel.app)
[![GitHub](https://img.shields.io/badge/github-Badgerion%2Fhollow-gray.svg)](https://github.com/Badgerion/hollow)

---

The standard way to give an AI agent a browser is to run a real browser — headless Chrome, Puppeteer, a BaaS provider — and either take screenshots for a vision model or dump the DOM and hope the model can parse it.

Both approaches were designed for humans. Screenshots because humans see. DOM dumps because humans read HTML. Neither was designed for the question an AI agent actually needs answered: **what is on this page, where is it, and what can I do with it?**

Hollow answers that question differently. It strips the browser down to the one step that produces spatial information — layout calculation — and runs that as a serverless function. No rendering. No pixels. No machine.

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

## The problem with the current approach

Every existing tool for AI browser agents carries the weight of a human browser:

**Screenshots + vision models** — the agent sees the page the way a human does, which means the model spends tokens describing what things look like instead of reasoning about what they are. Slow. Expensive. Brittle on dense UIs.

**Headless Chrome / Puppeteer / BaaS** — a real browser process running on a real machine. 300MB binary, 2–4 second cold starts, per-minute billing, a persistent server to maintain. The browser was built for humans sitting in front of screens. Running it headlessly is an afterthought, not a design.

**Raw HTML / curl + parser** — fast and cheap, but JavaScript-rendered content doesn't exist in raw HTML. Most modern sites are applications, not documents. curl gets you an empty div on any React SPA.

None of these tools fit the serverless, stateless, per-request reality of how AI agents actually run.

---

## What Hollow does instead

A browser pipeline has two separable concerns: **layout** (where things are — pure mathematics) and **painting** (how things look — requires a GPU and a screen).

Hollow keeps the layout step and drops everything after it.

It uses Happy DOM to execute JavaScript and build the DOM tree, then Yoga — the same layout engine that powers React Native — to calculate exact coordinates for every element. The result is a structured spatial tree called a [Graphical Density Grounding](https://github.com/Badgerion/GDG-browser) Spatial map: element IDs, positions, relationships. Everything an agent needs to reason and act. Nothing an agent doesn't.

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

![Matrix Mirror — Ghost DOM view showing Startpage rendered in the Mirror iframe, with TEXT tier, 0.95 confidence, and session ID in the top bar](https://raw.githubusercontent.com/Badgerion/hollow/main/assets/mirror-ghost-dom.png)

![Matrix Mirror — Hacker News loaded with TEXT tier, numbered element badges, 0.95 confidence, and live SSE pipeline log](https://raw.githubusercontent.com/Badgerion/hollow/main/assets/mirror-screenshot.png)

The Matrix Mirror is the observability UI. Type any URL, watch it load, see every element tagged and addressable. The agent log shows every routing decision, confidence score, and action in real time.

An AI agent ran 15 steps across 4 concurrent browser tabs — summarised a Hacker News comment thread, compared Reddit and HN simultaneously. 9/10 benchmark tasks completed.

Scan the QR code from any active session. Paste the system prompt into Claude, GPT, or Gemini. It has a working browser in 30 seconds. No API key. No setup.

---

## SDKs and integrations

| Package | Install | Description |
|---------|---------|-------------|
| **[hollow-sdk](https://npmjs.com/package/hollow-sdk)** | `npm install hollow-sdk` | TypeScript/Node SDK |
| **[hollow-sdk](https://pypi.org/project/hollow-sdk/)** | `pip install hollow-sdk` | Python SDK |
| **[hollow-mcp](https://npmjs.com/package/hollow-mcp)** | `npx hollow-mcp` | MCP server for Claude Desktop |

---

## Connect an agent

```typescript
import Anthropic from "@anthropic-ai/sdk"

const client = new Anthropic()
const HOLLOW = "https://hollow-tan-omega.vercel.app"

async function runAgent(task: string) {
  let { sessionId, gdgMap } = await fetch(`${HOLLOW}/api/perceive`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: "https://www.startpage.com" }),
  }).then((r) => r.json())

  for (let step = 0; step < 15; step++) {
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: `You are an AI agent with access to Hollow, a serverless browser.
You receive Graphical Density Grounding Spatial maps — structured page trees with actionable element IDs.
Respond with JSON only:
{ "type": "navigate", "url": "https://..." }
{ "type": "click", "elementId": 3 }
{ "type": "fill", "elementId": 4, "value": "text" }
{ "type": "done", "result": "your answer" }`,
      messages: [
        { role: "user", content: `Task: ${task}\n\nPage:\n${gdgMap}` },
      ],
    })

    const action = JSON.parse(response.content[0].text)
    if (action.type === "done") return action.result

    const next = await fetch(`${HOLLOW}/api/act`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, action }),
    }).then((r) => r.json())

    gdgMap = next.gdgMap
  }
}

runAgent("What are the top 3 stories on Hacker News right now?")
  .then(console.log)
```

---

## Deploy your own

```bash
git clone https://github.com/Badgerion/hollow
cd hollow
npm install
```

```env
UPSTASH_REDIS_REST_URL=your_url
UPSTASH_REDIS_REST_TOKEN=your_token
```

```bash
vercel deploy
```

No binaries. No Docker. No Chromium to install. A standard Next.js deploy.

---

## API

**POST /api/perceive** — load a page, start a session
```json
{ "url": "https://...", "sessionId": "optional", "stateId": "optional" }
→ { "sessionId", "gdgMap", "confidence", "tier", "jsErrors" }
```

**POST /api/act** — interact with the current page
```json
{ "sessionId": "sess:...", "action": { "type": "click", "elementId": 3 } }
→ { "sessionId", "gdgMap", "confidence", "tier" }
```

Action types: `navigate` · `click` · `fill` · `scroll` · `select` · `hover`

**GET /mirror** — observability UI

**GET /api/stream/:sessionId** — SSE event stream

---

## Contributing

Most valuable right now:
- Happy DOM polyfills — each one expands native coverage
- Mobile API registry — client profiles for more platforms
- WebSocket Skills — sync schemas for real-time apps

---

## License

Apache 2.0 for personal use, research, open source, and internal business use. Reach out if you need a commercial license.
