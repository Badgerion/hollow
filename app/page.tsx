'use client';

import { useSearchParams } from 'next/navigation';
import { useState, Suspense } from 'react';

const HOLLOW_ENDPOINT = 'https://hollow-tan-omega.vercel.app';
const GITHUB_URL = 'https://github.com/Badgerion/hollow';
const NPM_URL = 'https://npmjs.com/package/hollow-sdk';
const PYPI_URL = 'https://pypi.org/project/hollow-sdk';

const MCP_CONFIG = `{
  "mcpServers": {
    "hollow": {
      "command": "npx",
      "args": ["hollow-mcp"]
    }
  }
}`;

function buildSystemPrompt(session?: string | null): string {
  const sessionLine = session
    ? `\nActive session: ${session}\nYou can continue from this session immediately.\n`
    : '';
  return `You are an AI agent with access to Hollow, a serverless browser layer.
Endpoint: ${HOLLOW_ENDPOINT}
${sessionLine}
Use POST /api/perceive to load any URL — you get a GDG Spatial map with element IDs, positions, and relationships.
Use POST /api/act to interact with elements by ID.

Actions:
{ "type": "navigate", "url": "https://..." }
{ "type": "click", "elementId": N }
{ "type": "fill", "elementId": N, "value": "..." }
{ "type": "scroll", "y": N }
{ "type": "done", "result": "your answer" }

No browser required. No API key required.
Start with: POST /api/perceive { "url": "https://..." }`;
}

const TS_INSTALL = `npm install hollow-sdk`;
const TS_EXAMPLE = `import { HollowClient, runAgent } from 'hollow-sdk'
const hollow = new HollowClient()
const result = await runAgent(hollow, {
  task: 'Your task here'
})`;

const PY_INSTALL = `pip install hollow-sdk`;
const PY_EXAMPLE = `from hollow import HollowClient, run_agent
client = HollowClient()
result = run_agent(client, task='Your task here')`;

// ── Tiny SVG icons ─────────────────────────────────────────────────────────

function HornMark() {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
      <path d="M8 26 L16 6 L20 16 L24 6" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
      <circle cx="24" cy="6" r="2" fill="#00d4a4"/>
    </svg>
  );
}

function ClaudeIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
      <circle cx="10" cy="10" r="9" fill="#c9743a"/>
      <path d="M6.5 13.5 L10 6.5 L13.5 13.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      <line x1="7.5" y1="11.5" x2="12.5" y2="11.5" stroke="white" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
      <rect x="2" y="3" width="16" height="11" rx="3" stroke="rgba(255,255,255,0.5)" strokeWidth="1.5"/>
      <path d="M6 17 L7.5 14 L4 14 Z" fill="rgba(255,255,255,0.5)"/>
    </svg>
  );
}

function NodeIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
      <polygon points="10,2 18,7 18,13 10,18 2,13 2,7" stroke="#68a063" strokeWidth="1.5" fill="none"/>
      <text x="10" y="13.5" textAnchor="middle" fontSize="7" fill="#68a063" fontFamily="monospace" fontWeight="bold">JS</text>
    </svg>
  );
}

function PythonIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
      <path d="M10 2 C7 2 5 3.5 5 5.5 L5 8 L10 8 L10 9 L3 9 C1.5 9 1 10 1 11.5 L1 14.5 C1 16.5 3 18 6 18 L6 15.5 C6 14.5 6.8 14 8 14 L12 14 C13.5 14 15 13 15 11.5 L15 8.5 C15 6.5 13 5 12 5 L10 5" stroke="#3b7fb8" strokeWidth="1.2" fill="none" strokeLinecap="round"/>
      <circle cx="7.5" cy="5.5" r="1" fill="#3b7fb8"/>
      <path d="M10 18 C13 18 15 16.5 15 14.5 L15 12 L10 12 L10 11 L17 11 C18.5 11 19 10 19 8.5 L19 5.5 C19 3.5 17 2 14 2 L14 4.5 C14 5.5 13.2 6 12 6 L8 6 C6.5 6 5 7 5 8.5 L5 11.5 C5 13.5 7 15 8 15 L10 15" stroke="#ffcc00" strokeWidth="1.2" fill="none" strokeLinecap="round"/>
      <circle cx="12.5" cy="14.5" r="1" fill="#ffcc00"/>
    </svg>
  );
}

// ── Copy button ────────────────────────────────────────────────────────────

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  }

  return (
    <button
      onClick={handleCopy}
      style={{
        background: 'transparent',
        color: copied ? '#00d4a4' : 'rgba(255,255,255,0.5)',
        border: `1px solid ${copied ? 'rgba(0,212,164,0.4)' : 'rgba(255,255,255,0.12)'}`,
        borderRadius: '6px',
        padding: '6px 12px',
        fontSize: '11px',
        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
        cursor: 'pointer',
        letterSpacing: '0.02em',
        transition: 'border-color 0.15s, color 0.15s',
      }}
    >
      {copied ? 'Copied ✓' : label}
    </button>
  );
}

function CodeBlock({ code, label }: { code: string; label?: string }) {
  return (
    <div>
      <pre style={{
        background: '#0d0d0f',
        border: '1px solid rgba(255,255,255,0.06)',
        borderRadius: '6px',
        padding: '12px',
        fontSize: '11px',
        color: '#a3e635',
        overflowX: 'auto',
        whiteSpace: 'pre',
        margin: 0,
        lineHeight: '1.6',
        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      }}>
        {code}
      </pre>
      <div style={{ marginTop: '6px' }}>
        <CopyButton text={code} label={label ?? 'Copy'} />
      </div>
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────

const MONO = "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace";

function LandingContent() {
  const params = useSearchParams();
  const session = params.get('session');
  const [rawOpen, setRawOpen] = useState(false);
  const [sessionCopied, setSessionCopied] = useState(false);
  const [cardHover, setCardHover] = useState<number | null>(null);

  const systemPrompt = buildSystemPrompt(session);

  async function copySession() {
    if (!session) return;
    try {
      await navigator.clipboard.writeText(session);
      setSessionCopied(true);
      setTimeout(() => setSessionCopied(false), 2000);
    } catch {}
  }

  const cards = [
    {
      id: 0,
      icon: <ClaudeIcon />,
      title: 'Claude Desktop',
      badge: (
        <span style={{
          fontSize: '10px', padding: '2px 8px',
          background: 'rgba(0,212,164,0.15)', border: '1px solid rgba(0,212,164,0.3)',
          borderRadius: '10px', color: '#00d4a4', letterSpacing: '0.05em',
        }}>Recommended</span>
      ),
      content: (
        <>
          <CodeBlock code={MCP_CONFIG} label="Copy config" />
          <p style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)', lineHeight: 1.7, margin: 0 }}>
            Add to claude_desktop_config.json<br />
            Restart Claude Desktop
          </p>
          <div>
            <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer"
              style={{
                background: 'transparent', color: 'rgba(255,255,255,0.5)',
                border: '1px solid rgba(255,255,255,0.12)', borderRadius: '6px',
                padding: '6px 12px', fontSize: '11px', fontFamily: MONO,
                cursor: 'pointer', textDecoration: 'none', display: 'inline-block',
                letterSpacing: '0.02em',
              }}>
              Open docs ↗
            </a>
          </div>
        </>
      ),
    },
    {
      id: 1,
      icon: <ChatIcon />,
      title: 'Any AI (System Prompt)',
      badge: (
        <span style={{
          fontSize: '10px', padding: '2px 8px',
          background: 'rgba(96,165,250,0.15)', border: '1px solid rgba(96,165,250,0.3)',
          borderRadius: '10px', color: '#60a5fa', letterSpacing: '0.05em',
        }}>Universal</span>
      ),
      content: (
        <>
          <CodeBlock code={systemPrompt} label="Copy prompt" />
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' as const }}>
            {[
              ['Claude ↗', 'https://claude.ai'],
              ['ChatGPT ↗', 'https://chatgpt.com'],
              ['Gemini ↗', 'https://gemini.google.com'],
            ].map(([label, href]) => (
              <a key={href} href={href} target="_blank" rel="noopener noreferrer"
                style={{
                  background: 'transparent', color: 'rgba(255,255,255,0.5)',
                  border: '1px solid rgba(255,255,255,0.12)', borderRadius: '6px',
                  padding: '6px 12px', fontSize: '11px', fontFamily: MONO,
                  cursor: 'pointer', textDecoration: 'none', display: 'inline-block',
                  letterSpacing: '0.02em',
                }}>
                {label}
              </a>
            ))}
          </div>
        </>
      ),
    },
    {
      id: 2,
      icon: <NodeIcon />,
      title: 'TypeScript / Node',
      badge: null,
      content: (
        <>
          <CodeBlock code={TS_INSTALL} label="Copy" />
          <CodeBlock code={TS_EXAMPLE} label="Copy" />
          <div>
            <a href={NPM_URL} target="_blank" rel="noopener noreferrer"
              style={{
                background: 'transparent', color: 'rgba(255,255,255,0.5)',
                border: '1px solid rgba(255,255,255,0.12)', borderRadius: '6px',
                padding: '6px 12px', fontSize: '11px', fontFamily: MONO,
                cursor: 'pointer', textDecoration: 'none', display: 'inline-block',
                letterSpacing: '0.02em',
              }}>
              npm ↗
            </a>
          </div>
        </>
      ),
    },
    {
      id: 3,
      icon: <PythonIcon />,
      title: 'Python',
      badge: null,
      content: (
        <>
          <CodeBlock code={PY_INSTALL} label="Copy" />
          <CodeBlock code={PY_EXAMPLE} label="Copy" />
          <div>
            <a href={PYPI_URL} target="_blank" rel="noopener noreferrer"
              style={{
                background: 'transparent', color: 'rgba(255,255,255,0.5)',
                border: '1px solid rgba(255,255,255,0.12)', borderRadius: '6px',
                padding: '6px 12px', fontSize: '11px', fontFamily: MONO,
                cursor: 'pointer', textDecoration: 'none', display: 'inline-block',
                letterSpacing: '0.02em',
              }}>
              PyPI ↗
            </a>
          </div>
        </>
      ),
    },
  ];

  return (
    <div style={{
      background: '#0a0a0b',
      minHeight: '100vh',
      fontFamily: MONO,
      color: '#e5e5e7',
      padding: '48px 24px 80px',
      boxSizing: 'border-box',
    }}>
      {/* Header */}
      <div style={{ textAlign: 'center', marginBottom: '40px' }}>
        <div style={{ display: 'inline-flex', marginBottom: '12px' }}>
          <HornMark />
        </div>
        <span style={{ display: 'block', fontSize: '14px', letterSpacing: '0.3em', color: '#ffffff', marginBottom: '6px' }}>
          hollow
        </span>
        <span style={{ display: 'block', fontSize: '12px', color: 'rgba(255,255,255,0.4)', letterSpacing: '0.05em' }}>
          Connect your AI to the web
        </span>

        {session && (
          <div style={{ marginTop: '14px' }}>
            <button
              onClick={copySession}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: '8px',
                background: sessionCopied ? 'rgba(0,212,164,0.2)' : 'rgba(0,212,164,0.12)',
                border: '1px solid rgba(0,212,164,0.3)', borderRadius: '20px',
                padding: '5px 12px', fontSize: '11px', color: '#00d4a4',
                cursor: 'pointer', fontFamily: MONO, letterSpacing: '0.02em',
                userSelect: 'none', transition: 'background 0.15s',
              }}
            >
              <span style={{ opacity: 0.6 }}>Session:</span>
              <span style={{ maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {session}
              </span>
              <span style={{ opacity: 0.6 }}>{sessionCopied ? '✓' : '⎘'}</span>
            </button>
          </div>
        )}
      </div>

      {/* Provider cards — 2×2 grid */}
      <div className="hollow-grid" style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(2, 1fr)',
        gap: '16px',
        maxWidth: '860px',
        margin: '0 auto 32px',
      }}>
        {cards.map((card) => (
          <div
            key={card.id}
            style={{
              background: '#111113',
              border: `1px solid ${cardHover === card.id ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.08)'}`,
              borderRadius: '10px',
              padding: '20px',
              display: 'flex',
              flexDirection: 'column',
              gap: '14px',
              transition: 'border-color 0.15s',
            }}
            onMouseEnter={() => setCardHover(card.id)}
            onMouseLeave={() => setCardHover(null)}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              {card.icon}
              <span style={{ fontSize: '13px', fontWeight: 600, color: '#ffffff', flex: 1 }}>
                {card.title}
              </span>
              {card.badge}
            </div>
            {card.content}
          </div>
        ))}
      </div>

      {/* Raw API — collapsed */}
      <div style={{ maxWidth: '860px', margin: '0 auto 40px' }}>
        <button
          style={{
            background: 'transparent',
            border: `1px solid ${rawOpen ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.08)'}`,
            borderRadius: '6px', padding: '8px 14px', fontSize: '12px',
            color: 'rgba(255,255,255,0.4)', cursor: 'pointer', fontFamily: MONO,
            letterSpacing: '0.02em', transition: 'border-color 0.15s',
          }}
          onClick={() => setRawOpen(!rawOpen)}
        >
          {rawOpen ? '− Raw API' : '+ Raw API'}
        </button>

        {rawOpen && (
          <div style={{
            marginTop: '12px', background: '#111113',
            border: '1px solid rgba(255,255,255,0.08)', borderRadius: '10px', padding: '16px',
            display: 'flex', flexDirection: 'column', gap: '10px',
          }}>
            <div>
              <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.3)', marginBottom: '6px', letterSpacing: '0.08em' }}>
                PERCEIVE
              </div>
              <pre style={{ fontSize: '11px', color: '#a3e635', margin: 0, fontFamily: MONO, lineHeight: '1.6' }}>
                {`POST ${HOLLOW_ENDPOINT}/api/perceive\n{ "url": "https://..." }`}
              </pre>
            </div>
            <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '10px' }}>
              <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.3)', marginBottom: '6px', letterSpacing: '0.08em' }}>
                ACT
              </div>
              <pre style={{ fontSize: '11px', color: '#a3e635', margin: 0, fontFamily: MONO, lineHeight: '1.6' }}>
                {`POST ${HOLLOW_ENDPOINT}/api/act\n{ "sessionId": "sess:...", "action": {...} }`}
              </pre>
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div style={{ textAlign: 'center', maxWidth: '860px', margin: '0 auto', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px' }}>
        <a
          href={`${HOLLOW_ENDPOINT}/mirror`}
          style={{
            background: '#00d4a4', color: '#0a0a0b',
            border: 'none', borderRadius: '6px', padding: '10px 20px',
            fontSize: '12px', fontFamily: MONO, fontWeight: 600,
            letterSpacing: '0.02em', textDecoration: 'none', display: 'inline-block',
          }}
        >
          Try Matrix Mirror →
        </a>
        <div style={{ display: 'flex', gap: '20px', fontSize: '12px', color: 'rgba(255,255,255,0.3)' }}>
          {[['GitHub', GITHUB_URL], ['npm', NPM_URL], ['PyPI', PYPI_URL]].map(([label, href]) => (
            <a key={href} href={href} target="_blank" rel="noopener noreferrer"
              style={{ color: 'rgba(255,255,255,0.3)', textDecoration: 'none' }}>
              {label}
            </a>
          ))}
          <span style={{ color: 'rgba(255,255,255,0.15)' }}>Apache 2.0</span>
        </div>
      </div>

      {/* Mobile responsive override */}
      <style>{`
        @media (max-width: 600px) {
          .hollow-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={
      <div style={{ background: '#0a0a0b', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ color: 'rgba(255,255,255,0.2)', fontSize: '12px', fontFamily: 'monospace' }}>—</span>
      </div>
    }>
      <LandingContent />
    </Suspense>
  );
}
