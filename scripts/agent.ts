/**
 * Hollow agent loop — ContextAwarePlanningAgent pattern.
 *
 * Each step Claude reasons in four explicit phases before acting:
 *   EVALUATE  what did the last action accomplish?
 *   MEMORY    what relevant facts have I learned?
 *   GOAL      what is my immediate next step?
 *   ACTION    the exact JSON action to execute
 *
 * Usage:
 *   npx tsx scripts/agent.ts --task "What is the top story on Hacker News?"
 *
 * Environment:
 *   ANTHROPIC_API_KEY   required
 *   HOLLOW_URL          optional, defaults to https://hollow-tan-omega.vercel.app
 */

// ─── Config ──────────────────────────────────────────────────────────────────

const HOLLOW_URL = process.env.HOLLOW_URL ?? 'https://hollow-tan-omega.vercel.app';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? '';
const MAX_STEPS = 15;
const MAX_TABS = 5;
const MODEL = 'claude-sonnet-4-20250514';

// ─── Types ────────────────────────────────────────────────────────────────────

interface PerceiveResult {
  sessionId: string;
  gdgMap: string;
  confidence: number;
  tier: string;
}

interface Action {
  type: 'navigate' | 'click' | 'fill' | 'scroll' | 'done'
      | 'new_tab' | 'switch_tab' | 'close_tab';
  url?: string;
  elementId?: number;
  value?: string;
  direction?: string;
  result?: string;
  label?: string;
  sessionId?: string;
  stateId?: string;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

// ─── Session Manager ──────────────────────────────────────────────────────────

interface TabEntry {
  sessionId: string;
  url: string;
  gdgMap: string;
  confidence: number;
  tier: string;
  label: string;
}

class SessionManager {
  sessions: Map<string, TabEntry> = new Map();

  async open(url: string, label: string, stateId?: string): Promise<string> {
    if (this.sessions.size >= MAX_TABS) {
      throw new Error(`Maximum ${MAX_TABS} tabs already open — close one first`);
    }
    const result = await perceiveUrl({ url, stateId });
    const entry: TabEntry = {
      sessionId: result.sessionId,
      url,
      gdgMap: result.gdgMap,
      confidence: result.confidence,
      tier: result.tier,
      label,
    };
    this.sessions.set(result.sessionId, entry);
    return result.sessionId;
  }

  switch(sessionId: string): string {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not in tab registry`);
    return session.gdgMap;
  }

  update(sessionId: string, gdgMap: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry) entry.gdgMap = gdgMap;
  }

  close(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  keys(): string[] {
    return [...this.sessions.keys()];
  }

  list(): string {
    if (this.sessions.size === 0) return '  (no tabs open yet)';
    return [...this.sessions.values()]
      .map(s =>
        `  ${s.sessionId} [${s.label}] ${s.url} — ${s.tier} conf:${s.confidence.toFixed(2)}`
      )
      .join('\n');
  }
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(): string {
  const args = process.argv.slice(2);
  const i = args.indexOf('--task');
  if (i === -1 || !args[i + 1]) {
    console.error('Usage: npx tsx scripts/agent.ts --task "<task>"');
    process.exit(1);
  }
  return args[i + 1];
}

// ─── Hollow API ───────────────────────────────────────────────────────────────

async function perceiveUrl(opts: {
  url: string;
  sessionId?: string;
  stateId?: string;
}): Promise<PerceiveResult> {
  const body: Record<string, string> = { url: opts.url };
  if (opts.sessionId) body.sessionId = opts.sessionId;
  if (opts.stateId)   body.stateId   = opts.stateId;
  const res = await fetch(`${HOLLOW_URL}/api/perceive`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`/api/perceive ${res.status}: ${await res.text()}`);
  return res.json() as Promise<PerceiveResult>;
}

async function act(sessionId: string, action: Action): Promise<{ gdgMap?: string }> {
  const res = await fetch(`${HOLLOW_URL}/api/act`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, action }),
  });
  if (!res.ok) throw new Error(`/api/act ${res.status}: ${await res.text()}`);
  return res.json() as Promise<{ gdgMap?: string }>;
}

// ─── Claude API ───────────────────────────────────────────────────────────────

function buildSystemPrompt(sessionManager: SessionManager): string {
  return `You are an AI agent with access to Hollow, a serverless browser. \
You perceive the web through GDG Spatial maps — structured spatial trees of page layouts.

On each step, reason in this exact structure:

EVALUATE: [what did the last action accomplish? what changed on the page?]
MEMORY: [what relevant facts have I learned so far towards the goal?]
GOAL: [what is my immediate next step?]
ACTION: [one JSON object from the list below]

Available actions:
{ "type": "navigate", "url": "https://..." }
{ "type": "click", "elementId": 3 }
{ "type": "fill", "elementId": 4, "value": "text" }
{ "type": "scroll", "direction": "down" }
{ "type": "new_tab", "url": "https://...", "label": "descriptive-name" }
{ "type": "switch_tab", "sessionId": "sess:..." }
{ "type": "close_tab", "sessionId": "sess:..." }
{ "type": "done", "result": "your complete final answer here" }

You have access to multiple Hollow browser sessions simultaneously — like browser tabs.
Opening a new tab does not close the current one. Use tabs for parallel research.
Maximum ${MAX_TABS} tabs open simultaneously.

Current open sessions:
${sessionManager.list()}

Rules:
- Always output all four sections: EVALUATE, MEMORY, GOAL, ACTION.
- ACTION must be a single valid JSON object on its own line.
- Use { "type": "done" } only when you have a complete answer.
- Your first action will always be a navigate or new_tab — you decide the best URL.
- When you need to search for something or don't know the URL, navigate to https://www.startpage.com/
  and use the search box. Startpage works reliably with Hollow and returns quality search results.
- Use new_tab when researching multiple sources simultaneously — open all sources, then switch between them.`;
}

async function callClaude(messages: Message[], sessionManager: SessionManager): Promise<string> {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      system: buildSystemPrompt(sessionManager),
      messages,
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  const data = await res.json() as { content: { type: string; text: string }[] };
  return data.content.find(b => b.type === 'text')?.text ?? '';
}

// ─── Parse action from reasoning text ────────────────────────────────────────

function parseAction(text: string): Action {
  const matches = [...text.matchAll(/\{[^{}]*"type"\s*:\s*"[^"]+[^{}]*\}/g)];
  if (!matches.length) throw new Error(`No ACTION JSON found in:\n${text}`);
  const raw = matches[matches.length - 1][0];
  try {
    return JSON.parse(raw) as Action;
  } catch {
    throw new Error(`Failed to parse ACTION JSON: ${raw}`);
  }
}

// ─── Display ──────────────────────────────────────────────────────────────────

const HR = '─'.repeat(72);

function printStep(step: number, reasoning: string, action: Action, sessionManager: SessionManager) {
  console.log(`\n${HR}`);
  console.log(`  Step ${step} / ${MAX_STEPS}`);
  if (sessionManager.sessions.size > 1) {
    console.log(`  Open tabs: ${sessionManager.sessions.size}`);
    for (const [, tab] of sessionManager.sessions) {
      console.log(`    [${tab.label}] ${tab.sessionId} — ${tab.tier}`);
    }
  }
  console.log(HR);

  for (const line of reasoning.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^(EVALUATE|MEMORY|GOAL|ACTION):/.test(trimmed)) {
      console.log(`\n  ${trimmed}`);
    } else {
      console.log(`    ${trimmed}`);
    }
  }

  console.log(`\n  → ${JSON.stringify(action)}`);
}

// ─── Main loop ────────────────────────────────────────────────────────────────

async function main() {
  const task = parseArgs();
  const sessionManager = new SessionManager();

  console.log(`\n${HR}`);
  console.log('  Hollow Agent — ContextAwarePlanningAgent');
  console.log(HR);
  console.log(`  Task : ${task}`);
  console.log(`  Host : ${HOLLOW_URL}`);
  console.log(`  Model: ${MODEL}`);
  console.log('');

  const messages: Message[] = [];
  let currentSessionId: string | undefined;
  let gdgMap = '';
  let stepCount = 0;

  messages.push({
    role: 'user',
    content: `Task: ${task}\n\nNo page loaded yet. Choose where to navigate.`,
  });

  for (let step = 1; step <= MAX_STEPS; step++) {
    stepCount = step;

    const reasoning = await callClaude(messages, sessionManager);
    const action = parseAction(reasoning);

    printStep(step, reasoning, action, sessionManager);
    messages.push({ role: 'assistant', content: reasoning });

    // ── Execute the action ────────────────────────────────────────────────────
    if (action.type === 'done') {
      console.log(`\n${HR}`);
      console.log('  RESULT');
      console.log(HR);
      console.log(`\n  ${action.result ?? '(no result provided)'}`);
      console.log(`\n  Completed in ${stepCount} step${stepCount !== 1 ? 's' : ''}.\n`);
      return;
    }

    let newMap: string | undefined;

    if (action.type === 'new_tab') {
      if (!action.url) throw new Error('new_tab action missing url');
      const label = action.label ?? new URL(action.url).hostname.replace(/^www\./, '');
      process.stdout.write(`\n  Opening tab [${label}] ${action.url} … `);
      const newId = await sessionManager.open(action.url, label, action.stateId);
      currentSessionId = newId;
      gdgMap = sessionManager.switch(newId);
      newMap = gdgMap;
      console.log(`done — ${newId}`);

    } else if (action.type === 'switch_tab') {
      if (!action.sessionId) throw new Error('switch_tab action missing sessionId');
      process.stdout.write(`\n  Switching to tab ${action.sessionId} … `);
      gdgMap = sessionManager.switch(action.sessionId);
      currentSessionId = action.sessionId;
      newMap = gdgMap;
      console.log('done');

    } else if (action.type === 'close_tab') {
      if (!action.sessionId) throw new Error('close_tab action missing sessionId');
      sessionManager.close(action.sessionId);
      console.log(`\n  Closed tab ${action.sessionId}`);
      if (action.sessionId === currentSessionId) {
        const remaining = sessionManager.keys();
        if (remaining.length > 0) {
          currentSessionId = remaining[remaining.length - 1];
          gdgMap = sessionManager.switch(currentSessionId);
        } else {
          currentSessionId = undefined;
          gdgMap = '';
        }
      }
      newMap = gdgMap;

    } else if (action.type === 'navigate') {
      if (!action.url) throw new Error('navigate action missing url');
      process.stdout.write(`\n  Perceiving ${action.url} … `);
      const result = await perceiveUrl({ url: action.url, sessionId: currentSessionId });
      currentSessionId = result.sessionId;
      newMap = result.gdgMap;
      gdgMap = newMap;
      // Register in session manager under a derived label if not already there
      if (!sessionManager.sessions.has(currentSessionId)) {
        const label = new URL(action.url).hostname.replace(/^www\./, '');
        sessionManager.sessions.set(currentSessionId, {
          sessionId: currentSessionId, url: action.url, gdgMap: newMap,
          confidence: result.confidence, tier: result.tier, label,
        });
      } else {
        sessionManager.update(currentSessionId, newMap);
      }
      console.log('done');

    } else if (action.type === 'scroll') {
      if (!currentSessionId) throw new Error('no session — navigate first');
      process.stdout.write('\n  Scrolling … ');
      const result = await act(currentSessionId, action);
      newMap = result.gdgMap ?? gdgMap;
      gdgMap = newMap;
      sessionManager.update(currentSessionId, gdgMap);
      console.log('done');

    } else {
      // click / fill
      if (!currentSessionId) throw new Error('no session — navigate first');
      process.stdout.write(`\n  Acting (${action.type}) … `);
      const result = await act(currentSessionId, action);
      newMap = result.gdgMap ?? gdgMap;
      gdgMap = newMap;
      sessionManager.update(currentSessionId, gdgMap);
      console.log('done');
    }

    messages.push({
      role: 'user',
      content: `Action executed. Current page (session: ${currentSessionId ?? 'none'}):\n\n${gdgMap}`,
    });
  }

  // Hit max steps
  console.log(`\n${HR}`);
  console.log(`  Reached max steps (${MAX_STEPS}). Last page state:\n`);
  for (const line of gdgMap.split('\n').slice(0, 20)) console.log(`  ${line}`);
  if (gdgMap.split('\n').length > 20) console.log('  …');
  console.log('');
}

main().catch(err => {
  console.error('\n  ✗', err instanceof Error ? err.message : err);
  process.exit(1);
});
