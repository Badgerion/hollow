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
const MODEL = 'claude-sonnet-4-20250514';

const SYSTEM_PROMPT = `You are an AI agent with access to Hollow, a serverless browser. \
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
{ "type": "done", "result": "your complete final answer here" }

Rules:
- Always output all four sections: EVALUATE, MEMORY, GOAL, ACTION.
- ACTION must be a single valid JSON object on its own line.
- Use { "type": "done" } only when you have a complete answer.
- Your first action will always be a navigate — you decide the best URL.`;

// ─── Types ────────────────────────────────────────────────────────────────────

interface Action {
  type: 'navigate' | 'click' | 'fill' | 'scroll' | 'done';
  url?: string;
  elementId?: number;
  value?: string;
  direction?: string;
  result?: string;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
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

async function perceive(url: string, sessionId?: string): Promise<{ sessionId: string; gdgMap: string }> {
  const body: Record<string, string> = { url };
  if (sessionId) body.sessionId = sessionId;
  const res = await fetch(`${HOLLOW_URL}/api/perceive`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`/api/perceive ${res.status}: ${await res.text()}`);
  return res.json() as Promise<{ sessionId: string; gdgMap: string }>;
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

async function callClaude(messages: Message[]): Promise<string> {
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
      system: SYSTEM_PROMPT,
      messages,
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  const data = await res.json() as { content: { type: string; text: string }[] };
  return data.content.find(b => b.type === 'text')?.text ?? '';
}

// ─── Parse action from reasoning text ────────────────────────────────────────

function parseAction(text: string): Action {
  // Extract the last JSON object in the response (after the ACTION: label)
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

function printStep(step: number, reasoning: string, action: Action) {
  console.log(`\n${HR}`);
  console.log(`  Step ${step} / ${MAX_STEPS}`);
  console.log(HR);

  // Print reasoning sections with light indentation
  for (const line of reasoning.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Highlight the section headers
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

  console.log(`\n${HR}`);
  console.log('  Hollow Agent — ContextAwarePlanningAgent');
  console.log(HR);
  console.log(`  Task : ${task}`);
  console.log(`  Host : ${HOLLOW_URL}`);
  console.log(`  Model: ${MODEL}`);
  console.log('');

  const messages: Message[] = [];
  let sessionId: string | undefined;
  let gdgMap = '';
  let stepCount = 0;

  // Initial user message — no page yet, agent chooses where to navigate
  messages.push({
    role: 'user',
    content: `Task: ${task}\n\nNo page loaded yet. Choose where to navigate.`,
  });

  for (let step = 1; step <= MAX_STEPS; step++) {
    stepCount = step;

    // Ask Claude to reason and act
    const reasoning = await callClaude(messages);
    const action = parseAction(reasoning);

    printStep(step, reasoning, action);

    // Store the assistant turn in history
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

    if (action.type === 'navigate') {
      if (!action.url) throw new Error('navigate action missing url');
      process.stdout.write(`\n  Perceiving ${action.url} … `);
      const result = await perceive(action.url, sessionId);
      sessionId = result.sessionId;
      newMap    = result.gdgMap;
      gdgMap    = newMap;
      console.log('done');
    } else if (action.type === 'scroll') {
      // Scroll: re-perceive the same session (DOM may have loaded lazy content)
      if (!sessionId) throw new Error('no session — navigate first');
      process.stdout.write('\n  Scrolling … ');
      // scroll is handled server-side; fall back to re-perceiving same session
      const result = await act(sessionId, action);
      newMap  = result.gdgMap ?? gdgMap;
      gdgMap  = newMap;
      console.log('done');
    } else {
      // click / fill
      if (!sessionId) throw new Error('no session — navigate first');
      process.stdout.write(`\n  Acting (${action.type}) … `);
      const result = await act(sessionId, action);
      newMap  = result.gdgMap ?? gdgMap;
      gdgMap  = newMap;
      console.log('done');
    }

    // Feed the new page state back to Claude as the next user turn
    messages.push({
      role: 'user',
      content: `Action executed. Current page:\n\n${gdgMap}`,
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
