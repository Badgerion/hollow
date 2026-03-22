# Hollow

**A browser that has never run on a machine.**
Serverless web perception for AI agents. No Chromium. No BaaS. No GPU.

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Live](https://img.shields.io/badge/live-hollow--tan--omega.vercel.app-teal.svg)](https://hollow-tan-omega.vercel.app)
[![GitHub](https://img.shields.io/badge/github-Badgerion%2Fhollow-gray.svg)](https://github.com/Badgerion/hollow)

---

## The pain

Every AI agent that needs to browse the web is paying for a machine to run a browser.

You're either spinning up a VPS, paying Browserbase $0.05 per minute, managing a Puppeteer cluster that someone has to own and monitor, or waiting 4–8 seconds for a cold Chromium boot just to read a webpage. All of that infrastructure. All of that cost. All of that operational weight. Just so a model can read text that was already in the HTML.

Hollow removes the machine entirely. POST a URL, get back a structured map of the page. No process to boot. No GPU. No vendor invoice at the end of the month. No server to own.

```bash
curl -X POST https://hollow-tan-omega.vercel.app/api/perceive \
  -H "Content-Type: application/json" \
  -d '{"url": "https://news.ycombinator.com"}'
```

```json
{
  "sessionId": "sess:abc123",
  "gdgMap": "[TEXT: news.ycombinator.com]\n\n[Stories:]\n  [1] \"Ask HN: Who is hiring? (March 2026)\"\n      comments:834  link:[1]\n  [2] \"Show HN: I built a serverless browser\"\n      comments:291  link:[2]\n...",
  "confidence": 0.95,
  "tier": "text"
}
```

Response in under 2 seconds. No Chromium.

---

## The performance

Running the same 10-task agent benchmark — reading HN, Reddit, news sites, multi-tab comparisons, deep reads — across Hollow and a managed headless browser:

| | Hollow | Browserbase / Puppeteer |
|---|---|---|
| Cold start | 0 ms (serverless) | 4,000–8,000 ms |
| HN front page | ~1.8 s | ~6 s |
| Reddit r/programming | ~2.1 s | ~8 s |
| Per-task browser cost | ~$0.0003 | ~$0.30–$3.00 |
| Infrastructure | None | VM or managed cluster |
| Concurrent sessions | Unlimited | Plan-limited |
| Tasks passed (10 total) | **9 / 10** | — |

The agent ran 15 steps across 4 concurrent tabs, summarised an HN comment thread, compared Reddit and HN front pages simultaneously, and followed multi-step research chains. Laptop closed the entire time.

---

## The demo

Open the Matrix Mirror — Hollow's observability UI:

**[hollow-tan-omega.vercel.app/mirror](https://hollow-tan-omega.vercel.app/mirror)**

Type any URL. Watch the pipeline route it. See element badges on every actionable element, the confidence score, and which tier fired. Every active session has a QR code in the top bar — scan it and paste the one-liner into any AI to hand off a live browser session instantly.

Public demo is rate-limited to 10 requests per minute per IP. [Deploy your own instance](#deploy-your-own) for production use.

---

## How it routes

Not every page needs the same approach. Hollow detects the right path automatically and returns the fastest, highest-confidence map for each site type.

| Tier | What it does | Example sites | Typical latency |
|------|-------------|---------------|----------------|
| **TEXT** | Regex extraction — no DOM at all | Hacker News, lobste.rs, Reddit threads, Ars Technica, The Verge, Wired | < 2 s |
| **MOBILE API** | Fetches the site's own mobile JSON API | Reddit (live posts, scores, comments), Twitter/X | < 2 s |
| **HOLLOW** | Happy DOM + Yoga layout + GDG Spatial | GitHub, docs, most of the web | 3–8 s |
| **CACHE** | Wayback Machine or Bing cache fallback | Paywalled sites, WAF-blocked | 2–5 s |
| **PARTIAL** | Graceful degradation on error | Anything that returns a non-200 | instant |

Zero Chromium at every tier. The TEXT and MOBILE paths never touch a DOM engine at all.

---

## Connect an agent in 30 lines

```typescript
import Anthropic from "@anthropic-ai/sdk"

const client = new Anthropic()
const HOLLOW = "https://hollow-tan-omega.vercel.app"

async function runAgent(task: string) {
  // Load the first page
  let { sessionId, gdgMap } = await fetch(`${HOLLOW}/api/perceive`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: "https://www.startpage.com" }),
  }).then(r => r.json())

  for (let step = 0; step < 15; step++) {
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: `You are an AI agent using Hollow, a serverless browser.
You receive GDG Spatial maps — structured page trees with actionable element IDs.
Respond with one JSON action:
{ "type": "navigate", "url": "https://..." }
{ "type": "click",    "elementId": 3 }
{ "type": "fill",     "elementId": 4, "value": "search term" }
{ "type": "done",     "result": "your complete answer" }`,
      messages: [{ role: "user", content: `Task: ${task}\n\nPage:\n${gdgMap}` }],
    })

    const action = JSON.parse(response.content[0].text)
    if (action.type === "done") return action.result

    const next = await fetch(`${HOLLOW}/api/act`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, action }),
    }).then(r => r.json())

    gdgMap = next.gdgMap
  }
}

runAgent("What are the top 5 posts on Hacker News right now?")
  .then(console.log)
```

The `gdgMap` string is the only interface. Every tier returns the same shape — navigate, act, read, repeat.

---

## Deploy your own

Hollow is a standard Next.js app. No binaries. No Docker. No Chromium to install.

```bash
git clone https://github.com/Badgerion/hollow
cd hollow
npm install
```

Create an [Upstash Redis](https://upstash.com) database and add to `.env.local`:

```env
UPSTASH_REDIS_REST_URL=your_upstash_url
UPSTASH_REDIS_REST_TOKEN=your_upstash_token
```

```bash
vercel deploy
```

A cold Vercel deploy from zero takes about 3 minutes. A warm response is under 2 seconds on the TEXT tier, under 8 on HOLLOW. Set a spend limit in your Vercel dashboard before making it public.

---

## API

### `POST /api/perceive` — load a page, start a session

```json
{ "url": "https://...", "sessionId": "optional-existing", "stateId": "optional-hydra" }
```
```json
→ { "sessionId": "sess:...", "gdgMap": "...", "confidence": 0.95, "tier": "text" }
```

### `POST /api/act` — interact with the current session

```json
{ "sessionId": "sess:...", "action": { "type": "click", "elementId": 3 } }
```
```json
→ { "sessionId": "sess:...", "gdgMap": "...", "confidence": 0.97, "tier": "hollow" }
```

Action types: `navigate` · `click` · `fill` · `scroll` · `select` · `hover`

### `GET /api/sessions` — list active sessions

```json
→ { "sessions": [{ "sessionId": "sess:...", "url": "...", "tier": "text", "updatedAt": 1742547200 }] }
```

### `GET /api/stream/:sessionId` — SSE pipeline log

Real-time events from the perception pipeline. Each step emits a `log_entry` event with tag, message, and timestamp. Used by the Mirror.

### `GET /mirror` — observability UI

---

## License

Apache 2.0 for personal use, research, open source, and internal business use.

Commercial license required if you're offering Hollow as a hosted service to third parties. Reach out.

---

*Built by [Artiqal Labs](https://artiqal.vercel.app/). Hollow is the browser that was never built for you.*
