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
 *   npx tsx scripts/agent.ts --benchmark
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
// Truncate GDG maps in conversation history to keep token count under 30k TPM.
// Full map is shown for the most recent step; older steps get a trimmed version.
const GDG_MAX_LINES = 40;
// Sliding window — only send the last N messages to Claude per step.
// The MEMORY section in each assistant turn recaps context, so old messages
// are redundant and just burn tokens.
const MAX_HISTORY_MESSAGES = 6;

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

interface ClaudeResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

interface TaskResult {
  taskNum: number;
  description: string;
  expectedTier: string;
  steps: number;
  tiersUsed: string[];
  confidences: number[];
  finalAnswer: string;
  passed: boolean;
  timedOut: boolean;
  error?: string;
  inputTokens: number;
  outputTokens: number;
}

interface BenchmarkTask {
  num: number;
  description: string;
  task: string;
  expectedTier: string;
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

  /** Collect all unique tiers and confidence scores seen so far. */
  metrics(): { tiers: string[]; confidences: number[] } {
    const tiers: string[] = [];
    const confidences: number[] = [];
    for (const entry of this.sessions.values()) {
      if (!tiers.includes(entry.tier)) tiers.push(entry.tier);
      confidences.push(entry.confidence);
    }
    return { tiers, confidences };
  }
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

interface CliArgs {
  mode: 'task' | 'benchmark';
  task?: string;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  if (args.includes('--benchmark')) return { mode: 'benchmark' };
  const i = args.indexOf('--task');
  if (i === -1 || !args[i + 1]) {
    console.error('Usage: npx tsx scripts/agent.ts --task "<task>"');
    console.error('       npx tsx scripts/agent.ts --benchmark');
    process.exit(1);
  }
  return { mode: 'task', task: args[i + 1] };
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

Page tiers — how to read each map type:
- TEXT tier: fast extraction of headings, paragraphs, and links. Read content directly.
- MOBILE API tier: structured JSON data from the site's mobile API. The GDG map will show
  endpoint information and raw JSON fields instead of visual elements. Read the JSON content
  directly — post titles, scores, and metadata are in the map as field values, not as clickable
  links. To get post content, look for 'title', 'score', 'num_comments' fields in the map.
  You do not need to navigate further — the data is already in the map.
- Other tiers (high/medium/low): standard spatial layout map with clickable elements.

Rules:
- Always output all four sections: EVALUATE, MEMORY, GOAL, ACTION.
- ACTION must be a single valid JSON object on its own line.
- Use { "type": "done" } only when you have a complete answer.
- Your first action will always be a navigate or new_tab — you decide the best URL.
- When you need to search for something or don't know the URL, navigate to https://www.startpage.com/
  and use the search box. Startpage works reliably with Hollow and returns quality search results.
- Use new_tab when researching multiple sources simultaneously — open all sources, then switch between them.`;
}

async function callClaude(messages: Message[], sessionManager: SessionManager): Promise<ClaudeResponse> {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');

  // Sliding window — keep the initial task message + last MAX_HISTORY_MESSAGES.
  // The MEMORY section in each assistant turn recaps context, so old turns are
  // redundant and just accumulate tokens against the 30k TPM limit.
  const windowed =
    messages.length > MAX_HISTORY_MESSAGES + 1
      ? [messages[0], ...messages.slice(-MAX_HISTORY_MESSAGES)]
      : messages;

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
      messages: windowed,
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  const data = await res.json() as {
    content: { type: string; text: string }[];
    usage: { input_tokens: number; output_tokens: number };
  };
  return {
    text: data.content.find(b => b.type === 'text')?.text ?? '',
    inputTokens: data.usage?.input_tokens ?? 0,
    outputTokens: data.usage?.output_tokens ?? 0,
  };
}

// ─── GDG truncation — keeps token count under 30k TPM ────────────────────────

function truncateGdg(map: string, maxLines: number): string {
  const lines = map.split('\n');
  if (lines.length <= maxLines) return map;
  return lines.slice(0, maxLines).join('\n') + `\n… [truncated — ${lines.length - maxLines} more lines]`;
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

// ─── Core agent loop ──────────────────────────────────────────────────────────

async function runTask(
  task: string,
  taskNum: number,
  description: string,
  expectedTier: string,
): Promise<TaskResult> {
  const sessionManager = new SessionManager();
  const messages: Message[] = [];
  let currentSessionId: string | undefined;
  let gdgMap = '';
  let stepCount = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  // Per-step tier/confidence tracking (includes navigate + new_tab results)
  const tiersSeenSet = new Set<string>();
  const confidencesSeen: number[] = [];

  function recordPercept(result: PerceiveResult) {
    tiersSeenSet.add(result.tier);
    confidencesSeen.push(result.confidence);
  }

  messages.push({
    role: 'user',
    content: `Task: ${task}\n\nNo page loaded yet. Choose where to navigate.`,
  });

  for (let step = 1; step <= MAX_STEPS; step++) {
    stepCount = step;

    const claude = await callClaude(messages, sessionManager);
    totalInputTokens  += claude.inputTokens;
    totalOutputTokens += claude.outputTokens;

    const action = parseAction(claude.text);
    printStep(step, claude.text, action, sessionManager);
    messages.push({ role: 'assistant', content: claude.text });

    // ── Execute the action ──────────────────────────────────────────────────
    if (action.type === 'done') {
      const { tiers, confidences } = sessionManager.metrics();
      // Merge with any tiers captured from navigate results not yet in sessionManager
      for (const t of tiersSeenSet) if (!tiers.includes(t)) tiers.push(t);
      for (const c of confidencesSeen) if (!confidences.includes(c)) confidences.push(c);

      const answer = action.result ?? '';
      console.log(`\n${HR}`);
      console.log('  RESULT');
      console.log(HR);
      console.log(`\n  ${answer}`);
      console.log(`\n  Completed in ${stepCount} step${stepCount !== 1 ? 's' : ''}.`);
      console.log(`  Tokens: ${totalInputTokens} in / ${totalOutputTokens} out\n`);

      return {
        taskNum,
        description,
        expectedTier,
        steps: stepCount,
        tiersUsed: tiers,
        confidences,
        finalAnswer: answer,
        passed: answer.trim().length > 0,
        timedOut: false,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
      };
    }

    let newMap: string | undefined;

    if (action.type === 'new_tab') {
      if (!action.url) throw new Error('new_tab action missing url');
      const label = action.label ?? new URL(action.url).hostname.replace(/^www\./, '');
      process.stdout.write(`\n  Opening tab [${label}] ${action.url} … `);
      const newId = await sessionManager.open(action.url, label, action.stateId);
      // Capture tier/confidence from the newly opened tab entry
      const entry = sessionManager.sessions.get(newId);
      if (entry) { tiersSeenSet.add(entry.tier); confidencesSeen.push(entry.confidence); }
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
      recordPercept(result);
      currentSessionId = result.sessionId;
      newMap = result.gdgMap;
      gdgMap = newMap;
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

    // Truncate GDG in all prior user messages to keep token count manageable
    for (const msg of messages) {
      if (msg.role === 'user' && msg.content.startsWith('Action executed.')) {
        const marker = '\n\n';
        const idx = msg.content.indexOf(marker);
        if (idx !== -1) {
          const prefix = msg.content.slice(0, idx + marker.length);
          const body = msg.content.slice(idx + marker.length);
          msg.content = prefix + truncateGdg(body, GDG_MAX_LINES);
        }
      }
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

  const { tiers, confidences } = sessionManager.metrics();
  for (const t of tiersSeenSet) if (!tiers.includes(t)) tiers.push(t);
  for (const c of confidencesSeen) if (!confidences.includes(c)) confidences.push(c);

  return {
    taskNum,
    description,
    expectedTier,
    steps: stepCount,
    tiersUsed: tiers,
    confidences,
    finalAnswer: '',
    passed: false,
    timedOut: true,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
  };
}

// ─── Benchmark ────────────────────────────────────────────────────────────────

const BENCHMARK_TASKS: BenchmarkTask[] = [
  {
    num: 1,
    description: 'TEXT tier, single page read',
    task: 'What are the top 5 stories on Hacker News right now? List title and comment count.',
    expectedTier: 'text',
  },
  {
    num: 2,
    description: 'TEXT tier, navigation',
    task: 'Go to the first story on Hacker News and tell me the domain it links to.',
    expectedTier: 'text',
  },
  {
    num: 3,
    description: 'HOLLOW tier, simple site',
    task: 'What is the main headline on example.com?',
    expectedTier: 'high/medium/low',
  },
  {
    num: 4,
    description: 'MOBILE tier, Reddit',
    task: 'What is the top post on r/programming today and how many upvotes does it have?',
    expectedTier: 'mobile-api',
  },
  {
    num: 5,
    description: 'MOBILE tier, Reddit navigation',
    task: "Find a post about Python on r/programming and summarise what it's about.",
    expectedTier: 'mobile-api',
  },
  {
    num: 6,
    description: 'CACHE tier, news site',
    task: 'What is the lead story on arstechnica.com right now?',
    expectedTier: 'cache',
  },
  {
    num: 7,
    description: 'HOLLOW tier, search',
    task: "Search for 'serverless browser' on Startpage and list the first 3 results.",
    expectedTier: 'text',
  },
  {
    num: 8,
    description: 'Multi-step, multi-tier (TEXT → TEXT)',
    task: 'Find the most recent post about AI on Hacker News, then search for the company or project mentioned in the title on Startpage and tell me what it does.',
    expectedTier: 'text → text',
  },
  {
    num: 9,
    description: 'Multi-tab comparison (TEXT + MOBILE)',
    task: 'Open Hacker News and Reddit r/technology simultaneously and tell me which has more AI stories on the front page today.',
    expectedTier: 'text + mobile-api',
  },
  {
    num: 10,
    description: 'Deep read, multi-step',
    task: 'Find a Show HN post from today on Hacker News and summarise both the project and the top 3 comments.',
    expectedTier: 'text',
  },
];

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

async function runBenchmark() {
  const mirrorUrl = `${HOLLOW_URL}/mirror`;

  console.log(`\n${'═'.repeat(72)}`);
  console.log('  Hollow Agent — Structured Benchmark');
  console.log(`${'═'.repeat(72)}`);
  console.log(`  Host   : ${HOLLOW_URL}`);
  console.log(`  Model  : ${MODEL}`);
  console.log(`  Tasks  : ${BENCHMARK_TASKS.length}`);
  console.log(`  Mirror : ${mirrorUrl}`);
  console.log(`${'═'.repeat(72)}\n`);
  console.log('  Open the Mirror URL above to observe sessions live.');
  console.log('  Starting in 3 seconds…\n');
  await sleep(3000);

  const results: TaskResult[] = [];

  for (const bt of BENCHMARK_TASKS) {
    console.log(`\n${'═'.repeat(72)}`);
    console.log(`  BENCHMARK TASK ${bt.num} / ${BENCHMARK_TASKS.length} — ${bt.description}`);
    console.log(`  Expected tier: ${bt.expectedTier}`);
    console.log(`${'═'.repeat(72)}`);
    console.log(`  Task: ${bt.task}`);
    console.log(`  Mirror: ${mirrorUrl}\n`);

    let result: TaskResult;
    try {
      result = await runTask(bt.task, bt.num, bt.description, bt.expectedTier);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\n  ✗ Task ${bt.num} threw: ${msg}\n`);
      result = {
        taskNum: bt.num,
        description: bt.description,
        expectedTier: bt.expectedTier,
        steps: 0,
        tiersUsed: [],
        confidences: [],
        finalAnswer: '',
        passed: false,
        timedOut: false,
        error: msg,
        inputTokens: 0,
        outputTokens: 0,
      };
    }

    results.push(result);

    // Brief pause between tasks to avoid rate limits
    if (bt.num < BENCHMARK_TASKS.length) {
      console.log('  Pausing 5 s before next task…');
      await sleep(5000);
    }
  }

  // ── Summary table ─────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(72)}`);
  console.log('  BENCHMARK SUMMARY');
  console.log(`${'═'.repeat(72)}\n`);

  const COL = { task: 4, desc: 26, steps: 5, tier: 18, conf: 6, tokens: 10, result: 6 };

  const header = [
    pad('Task', COL.task),
    pad('Description', COL.desc),
    pad('Steps', COL.steps),
    pad('Tier(s)', COL.tier),
    pad('Conf', COL.conf),
    pad('Tokens', COL.tokens),
    pad('Result', COL.result),
  ].join(' │ ');
  console.log('  ' + header);
  console.log('  ' + '─'.repeat(header.length));

  let totalPass = 0;
  let totalTokensIn = 0;
  let totalTokensOut = 0;

  for (const r of results) {
    const status = r.error
      ? '✗ ERR'
      : r.timedOut
        ? '✗ TIMEOUT'
        : r.passed
          ? '✓ PASS'
          : '✗ FAIL';

    const tier = r.tiersUsed.join('+') || '—';
    const avgConf = r.confidences.length
      ? (r.confidences.reduce((a, b) => a + b, 0) / r.confidences.length).toFixed(2)
      : '—';
    const tokens = `${r.inputTokens}/${r.outputTokens}`;

    const row = [
      pad(String(r.taskNum), COL.task),
      pad(r.description, COL.desc),
      pad(String(r.steps), COL.steps),
      pad(tier, COL.tier),
      pad(avgConf, COL.conf),
      pad(tokens, COL.tokens),
      pad(status, COL.result),
    ].join(' │ ');
    console.log('  ' + row);

    if (r.passed) totalPass++;
    totalTokensIn  += r.inputTokens;
    totalTokensOut += r.outputTokens;
  }

  console.log('  ' + '─'.repeat(header.length));
  console.log(`\n  Passed : ${totalPass} / ${BENCHMARK_TASKS.length}`);
  console.log(`  Failed : ${BENCHMARK_TASKS.length - totalPass} / ${BENCHMARK_TASKS.length}`);
  console.log(`  Tokens : ${totalTokensIn} in / ${totalTokensOut} out (${totalTokensIn + totalTokensOut} total)`);
  console.log(`  Mirror : ${mirrorUrl}\n`);

  // Detailed per-task answers
  console.log(`${'═'.repeat(72)}`);
  console.log('  TASK ANSWERS');
  console.log(`${'═'.repeat(72)}\n`);
  for (const r of results) {
    console.log(`  [Task ${r.taskNum}] ${r.description}`);
    if (r.error) {
      console.log(`    ERROR: ${r.error}`);
    } else if (r.timedOut) {
      console.log('    TIMED OUT — hit max steps without completing.');
    } else {
      const answer = r.finalAnswer.replace(/\n/g, '\n    ');
      console.log(`    ${answer}`);
    }
    console.log('');
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const cli = parseArgs();

  if (cli.mode === 'benchmark') {
    await runBenchmark();
    return;
  }

  // Single task mode
  const task = cli.task!;
  const mirrorUrl = `${HOLLOW_URL}/mirror`;

  console.log(`\n${HR}`);
  console.log('  Hollow Agent — ContextAwarePlanningAgent');
  console.log(HR);
  console.log(`  Task  : ${task}`);
  console.log(`  Host  : ${HOLLOW_URL}`);
  console.log(`  Model : ${MODEL}`);
  console.log(`  Mirror: ${mirrorUrl}`);
  console.log('');

  await runTask(task, 0, 'single task', '—');
}

main().catch(err => {
  console.error('\n  ✗', err instanceof Error ? err.message : err);
  process.exit(1);
});
