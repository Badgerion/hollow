/**
 * Hollow agent loop — drives a browser session using Claude as the reasoning engine.
 *
 * Usage:
 *   npx tsx scripts/agent.ts --url "https://example.com" --task "Find the main heading"
 *
 * Environment:
 *   ANTHROPIC_API_KEY   required
 *   HOLLOW_URL          optional, defaults to https://hollow-tan-omega.vercel.app
 */

// ─── Config ──────────────────────────────────────────────────────────────────

const HOLLOW_URL = process.env.HOLLOW_URL ?? 'https://hollow-tan-omega.vercel.app';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? '';
const MAX_STEPS = 10;
const MODEL = 'claude-sonnet-4-20250514';

const SYSTEM_PROMPT = `You are an AI agent operating a browser through Hollow, a serverless DOM interpreter.
You receive a GDG Spatial map showing the current page layout. Actionable elements have IDs like [12], [13] etc.

To take an action, respond with a JSON object on its own line:
  { "action": "click", "elementId": 12 }
  { "action": "fill", "elementId": 15, "value": "some text" }
  { "action": "navigate", "url": "https://..." }
  { "action": "done", "result": "your answer here" }

Rules:
- Always respond with exactly one JSON action.
- If the task is complete, use { "action": "done", "result": "..." }.
- If the page does not have what you need, navigate or click to find it.
- Do not explain — just output the JSON action.`;

// ─── CLI args ────────────────────────────────────────────────────────────────

function parseArgs(): { url: string; task: string } {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : null;
  };
  const url  = get('--url');
  const task = get('--task');
  if (!url || !task) {
    console.error('Usage: npx tsx scripts/agent.ts --url "<url>" --task "<task>"');
    process.exit(1);
  }
  return { url, task };
}

// ─── Hollow API helpers ───────────────────────────────────────────────────────

interface PerceiveResult {
  sessionId: string;
  gdgMap: string;
  confidence: number;
  tier: string;
}

async function perceive(url: string, sessionId?: string): Promise<PerceiveResult> {
  const body: Record<string, string> = { url };
  if (sessionId) body.sessionId = sessionId;

  const res = await fetch(`${HOLLOW_URL}/api/perceive`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`/api/perceive ${res.status}: ${text}`);
  }
  return res.json() as Promise<PerceiveResult>;
}

interface ActResult {
  gdgMap?: string;
  sessionId: string;
}

async function act(sessionId: string, action: AgentAction): Promise<ActResult> {
  const res = await fetch(`${HOLLOW_URL}/api/act`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, ...action }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`/api/act ${res.status}: ${text}`);
  }
  return res.json() as Promise<ActResult>;
}

// ─── Claude API helper ────────────────────────────────────────────────────────

async function askClaude(task: string, gdgMap: string): Promise<AgentAction> {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');

  const userMessage = `Task: ${task}\n\nCurrent page:\n${gdgMap}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':         'application/json',
      'x-api-key':            ANTHROPIC_API_KEY,
      'anthropic-version':    '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 256,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${text}`);
  }

  const data = await res.json() as { content: { type: string; text: string }[] };
  const text = data.content.find(b => b.type === 'text')?.text ?? '';

  return parseAction(text);
}

// ─── Action types ─────────────────────────────────────────────────────────────

type AgentAction =
  | { action: 'click';    elementId: number }
  | { action: 'fill';     elementId: number; value: string }
  | { action: 'navigate'; url: string }
  | { action: 'done';     result: string };

function parseAction(text: string): AgentAction {
  // Find the first JSON object in the response
  const match = text.match(/\{[^}]+\}/);
  if (!match) throw new Error(`No JSON action found in response:\n${text}`);
  try {
    return JSON.parse(match[0]) as AgentAction;
  } catch {
    throw new Error(`Failed to parse action JSON: ${match[0]}`);
  }
}

// ─── Display helpers ──────────────────────────────────────────────────────────

const HR = '─'.repeat(64);

function printStep(step: number, gdgMap: string, action: AgentAction) {
  console.log(`\n${HR}`);
  console.log(`  Step ${step} / ${MAX_STEPS}`);
  console.log(HR);
  console.log('\n  GDG Map received:\n');
  // Indent each line for readability
  for (const line of gdgMap.split('\n').slice(0, 30)) {
    console.log(`    ${line}`);
  }
  if (gdgMap.split('\n').length > 30) {
    console.log(`    … (${gdgMap.split('\n').length - 30} more lines)`);
  }
  console.log('\n  Action decided:\n');
  console.log(`    ${JSON.stringify(action)}`);
  console.log('');
}

// ─── Main loop ────────────────────────────────────────────────────────────────

async function main() {
  const { url, task } = parseArgs();

  console.log(`\n${HR}`);
  console.log('  Hollow Agent Loop');
  console.log(HR);
  console.log(`  URL  : ${url}`);
  console.log(`  Task : ${task}`);
  console.log(`  Host : ${HOLLOW_URL}`);
  console.log('');

  // Step 1: perceive the initial URL
  process.stdout.write('  Perceiving initial URL… ');
  let result = await perceive(url);
  let { sessionId, gdgMap } = result;
  console.log(`done  (session ${sessionId})`);

  // Main agent loop
  for (let step = 1; step <= MAX_STEPS; step++) {
    // Ask Claude what to do next
    const action = await askClaude(task, gdgMap);
    printStep(step, gdgMap, action);

    if (action.action === 'done') {
      console.log(`${HR}`);
      console.log('  RESULT');
      console.log(HR);
      console.log(`\n  ${action.result}\n`);
      return;
    }

    if (action.action === 'navigate') {
      process.stdout.write(`  Navigating to ${action.url}… `);
      const nav = await perceive(action.url, sessionId);
      sessionId = nav.sessionId;
      gdgMap    = nav.gdgMap;
      console.log('done');
      continue;
    }

    // click or fill — send to /api/act
    process.stdout.write(`  Acting (${action.action})… `);
    const actResult = await act(sessionId, action);
    if (actResult.gdgMap) gdgMap = actResult.gdgMap;
    console.log('done');
  }

  console.log(`\n${HR}`);
  console.log(`  Reached max steps (${MAX_STEPS}). Final GDG map:\n`);
  console.log(gdgMap);
  console.log('');
}

main().catch(err => {
  console.error('\n  ✗ Agent error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
