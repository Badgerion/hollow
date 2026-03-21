'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

type LogTag = 'SYS' | 'GDG' | 'AI' | 'ACT' | 'OK' | 'WARN' | 'ERR';
type Tier = 'hollow' | 'partial' | 'vdom' | 'mobile-api' | 'cache';
type ConnStatus = 'disconnected' | 'connecting' | 'connected' | 'polling' | 'error';

interface LogEntry {
  id: string;
  tag: LogTag;
  message: string;
  timestamp: string;
  gdgMap?: string;
  confidence?: number;
  tier?: Tier;
  /** Opaque key used to deduplicate events from SSE + polling firing simultaneously. */
  dedupKey?: string;
}

// ─── Design tokens ────────────────────────────────────────────────────────────

const C = {
  bg:        '#0a0a0a',
  panel:     '#0f0f0f',
  border:    '#1c1c1c',
  borderMid: '#222',
  text:      '#e2e2e2',
  muted:     '#555',
  teal:      '#0d9488',
  tealDim:   '#042f2e',
  font:      `'IBM Plex Mono', 'Courier New', monospace`,
} as const;

const TAG_COLOR: Record<LogTag, string> = {
  SYS:  '#6b7280',
  GDG:  '#a78bfa',
  AI:   '#60a5fa',
  ACT:  '#0d9488',
  OK:   '#4ade80',
  WARN: '#fbbf24',
  ERR:  '#f87171',
};

const TAG_BG: Record<LogTag, string> = {
  SYS:  '#18181b',
  GDG:  '#2e1065',
  AI:   '#172554',
  ACT:  '#042f2e',
  OK:   '#052e16',
  WARN: '#431407',
  ERR:  '#450a0a',
};

// ─── Utilities ────────────────────────────────────────────────────────────────

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('en-US', {
      hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch {
    return '--:--:--';
  }
}

function confColor(score: number): string {
  if (score >= 0.9) return '#4ade80';
  if (score >= 0.8) return '#fbbf24';
  return '#f87171';
}

function uid() { return `${Date.now()}-${Math.random().toString(36).slice(2)}`; }

function looksLikeUrl(s: string): boolean {
  const t = s.trim();
  return t.startsWith('http://') || t.startsWith('https://');
}

// Inject badge + highlight + click-intercept script into Ghost DOM HTML
function injectHollowScript(html: string, sessionUrl?: string): string {
  const baseTag = sessionUrl && sessionUrl !== '—'
    ? `<base href="${sessionUrl}">`
    : '';
  const script = `<script>
(function(){
  var SEL='a[href],button,input,select,textarea,[role="button"],[onclick],[tabindex]:not([tabindex="-1"])';
  function init(){
    var els=Array.from(document.querySelectorAll(SEL));
    els.forEach(function(el,i){
      var r=el.getBoundingClientRect();
      if(r.width===0&&r.height===0)return;
      var b=document.createElement('span');
      b.textContent=i+1;
      b.setAttribute('data-hid',i+1);
      b.setAttribute('data-hollow-id',i+1);
      el.setAttribute('data-hollow-id',i+1);
      b.style.cssText='position:absolute;top:-9px;left:0;background:#0d9488;color:#fff;'+
        'font:700 9px/1 monospace;padding:1px 4px;border-radius:2px;z-index:2147483647;'+
        'pointer-events:none;white-space:nowrap;';
      var s=window.getComputedStyle(el);
      if(s.position==='static')el.style.position='relative';
      el.style.zIndex=el.style.zIndex||'1';
      el.appendChild(b);
    });
    // Intercept handled clicks — prevent iframe navigation, route through Hollow
    document.addEventListener('click',function(e){
      var el=e.target.closest('a,button,[role="button"]');
      if(!el)return;
      var hollowId=el.dataset&&el.dataset.hollowId
        ?parseInt(el.dataset.hollowId)
        :null;
      var href=el.getAttribute('href')||null;
      // Only intercept if we can handle it — prevents "refused to connect"
      if(!hollowId&&!href)return;
      e.preventDefault();
      window.parent.postMessage({
        type:'hollow-click',
        hollowId:hollowId,
        href:href,
        text:(el.textContent||'').trim().slice(0,80)
      },'*');
    },true);
    window.addEventListener('message',function(e){
      if(!e.data||e.data.type!=='hollow:highlight')return;
      document.querySelectorAll('[data-hollow-active]').forEach(function(el){
        el.removeAttribute('data-hollow-active');
        el.style.outline='';el.style.outlineOffset='';
      });
      var t=els[e.data.id-1];
      if(t){
        t.setAttribute('data-hollow-active','1');
        t.style.outline='2px solid #0d9488';
        t.style.outlineOffset='2px';
        t.scrollIntoView({behavior:'smooth',block:'center'});
      }
    });
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);
  else init();
})();
<\/script>`;
  // Inject <base> before </head> if present, otherwise prepend to html
  let result = html;
  if (baseTag) {
    if (result.includes('</head>')) {
      result = result.replace('</head>', baseTag + '</head>');
    } else if (result.includes('<head>')) {
      result = result.replace('<head>', '<head>' + baseTag);
    } else {
      result = baseTag + result;
    }
  }
  if (result.includes('</body>')) return result.replace('</body>', script + '</body>');
  return result + script;
}

// ─── API helper ───────────────────────────────────────────────────────────────

async function callPerceive(input: string, sessionId?: string): Promise<{ sessionId: string }> {
  const body: Record<string, string> = looksLikeUrl(input)
    ? { url: input.trim() }
    : { html: input.trim() };
  if (sessionId) body.sessionId = sessionId;

  const res = await fetch('/api/perceive', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json as { sessionId: string };
}

async function callAct(sessionId: string, action: { type: string; elementId?: number; url?: string }): Promise<void> {
  await fetch('/api/act', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, action }),
  });
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatusDot({ status }: { status: ConnStatus }) {
  const color = status === 'connected' ? '#4ade80'
    : status === 'connecting' ? '#fbbf24'
    : status === 'polling'    ? '#60a5fa'
    : status === 'error'      ? '#f87171'
    : '#555';
  const label = status === 'connected' ? 'CONNECTED'
    : status === 'connecting' ? 'CONNECTING'
    : status === 'polling'    ? 'POLLING'
    : status === 'error'      ? 'ERROR'
    : 'DISCONNECTED';
  const glow = status === 'connected' || status === 'polling';
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '10px', color: '#888' }}>
      <span style={{
        width: 7, height: 7, borderRadius: '50%', background: color, flexShrink: 0,
        boxShadow: glow ? `0 0 6px ${color}` : 'none',
      }} />
      {label}
    </span>
  );
}

// ─── QR Connector ─────────────────────────────────────────────────────────────

function QRConnector({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const endpoint = typeof window !== 'undefined' ? window.location.origin : 'https://hollow-tan-omega.vercel.app';

  const payload = JSON.stringify({
    hollow_session: {
      endpoint,
      sessionId,
      perceive: '/api/perceive',
      act: '/api/act',
      stream: `/api/stream/${sessionId}`,
      instructions:
        'POST to /api/perceive with {url, sessionId} to browse. ' +
        'POST to /api/act with {sessionId, action} to interact. ' +
        'GDG Spatial maps are returned — structured spatial trees for AI reasoning.',
    },
  });

  const systemPrompt =
    `You have access to a Hollow browser.\n` +
    `Endpoint: ${endpoint}\n` +
    `Session: ${sessionId}\n` +
    `POST /api/perceive {url, sessionId} to load pages.\n` +
    `POST /api/act {sessionId, action} to interact.\n` +
    `Pages return as GDG Spatial maps — token-efficient\n` +
    `structured trees. Element IDs like [1],[2] are\n` +
    `actionable. Navigate, click, fill forms freely.`;

  useEffect(() => {
    if (!open || !canvasRef.current) return;
    import('qrcode').then(QRCode => {
      QRCode.toCanvas(canvasRef.current!, payload, {
        width: 80,
        margin: 1,
        color: { dark: '#e2e2e2', light: '#0a0a0a' },
      });
    });
  }, [open, payload]);

  function copyPrompt() {
    navigator.clipboard.writeText(systemPrompt).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      {/* QR icon toggle button */}
      <button
        onClick={() => setOpen(o => !o)}
        title="Share session — scan to connect any AI agent"
        style={{
          background: open ? '#042f2e' : 'transparent',
          border: `1px solid ${open ? '#0d9488' : '#333'}`,
          borderRadius: 3,
          color: open ? '#5eead4' : '#444',
          fontFamily: C.font,
          fontSize: 13,
          padding: '1px 6px',
          cursor: 'pointer',
          lineHeight: '20px',
          userSelect: 'none' as const,
        }}
      >
        ▦
      </button>

      {/* Collapsible panel */}
      {open && (
        <div style={{
          position: 'absolute',
          top: 'calc(100% + 8px)',
          right: 0,
          background: '#0f0f0f',
          border: `1px solid ${C.border}`,
          borderRadius: 6,
          padding: 14,
          zIndex: 200,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          width: 270,
          boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
        }}>
          {/* Header */}
          <div style={{ fontSize: 9, color: '#555', letterSpacing: '0.12em', textTransform: 'uppercase' as const }}>
            AI Agent Connector
          </div>

          {/* QR Code */}
          <div style={{ display: 'flex', justifyContent: 'center', padding: '4px 0' }}>
            <canvas
              ref={canvasRef}
              width={80}
              height={80}
              style={{ imageRendering: 'pixelated' as const, borderRadius: 3 }}
            />
          </div>

          {/* Hint */}
          <div style={{ fontSize: 9, color: '#333', textAlign: 'center' as const, lineHeight: 1.5 }}>
            Scan to connect any AI agent to this session
          </div>

          {/* System prompt label */}
          <div style={{ fontSize: 9, color: '#555', letterSpacing: '0.1em', textTransform: 'uppercase' as const }}>
            One-liner system prompt
          </div>

          {/* Prompt text */}
          <pre style={{
            margin: 0,
            background: '#0a0a0a',
            border: `1px solid #1c1c1c`,
            borderRadius: 3,
            padding: '8px 10px',
            fontSize: 9,
            color: '#666',
            lineHeight: 1.7,
            whiteSpace: 'pre-wrap' as const,
            wordBreak: 'break-word' as const,
            fontFamily: C.font,
          }}>
            {systemPrompt}
          </pre>

          {/* Copy button */}
          <button
            onClick={copyPrompt}
            style={{
              background: copied ? '#052e16' : '#042f2e',
              border: `1px solid ${copied ? '#4ade80' : '#0d9488'}`,
              borderRadius: 3,
              color: copied ? '#4ade80' : '#5eead4',
              fontFamily: C.font,
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.06em',
              padding: '5px 8px',
              cursor: 'pointer',
              textTransform: 'uppercase' as const,
            }}
          >
            {copied ? '✓ Copied' : 'Copy Prompt'}
          </button>
        </div>
      )}
    </div>
  );
}

function TierPill({ tier }: { tier: Tier | null }) {
  if (!tier) return null;
  const colors: Record<Tier, { bg: string; text: string; border: string }> = {
    hollow:       { bg: '#052e16', text: '#4ade80', border: '#166534' },
    partial:      { bg: '#431407', text: '#fb923c', border: '#92400e' },
    vdom:         { bg: '#1e1b4b', text: '#a78bfa', border: '#4338ca' },
    'mobile-api': { bg: '#172554', text: '#60a5fa', border: '#1d4ed8' },
    cache:        { bg: '#422006', text: '#fbbf24', border: '#92400e' },
  };
  const c = colors[tier] ?? colors.partial;
  return (
    <span style={{
      padding: '2px 8px',
      borderRadius: '4px',
      fontSize: '10px',
      fontWeight: 700,
      letterSpacing: '0.1em',
      textTransform: 'uppercase' as const,
      background: c.bg,
      color: c.text,
      border: `1px solid ${c.border}`,
    }}>
      {tier === 'mobile-api' ? 'MOBILE' : tier === 'cache' ? 'CACHE' : tier}
    </span>
  );
}

function TagBadge({ tag }: { tag: LogTag }) {
  return (
    <span style={{
      display: 'inline-block',
      padding: '0 6px',
      borderRadius: '3px',
      fontSize: '10px',
      fontWeight: 700,
      letterSpacing: '0.06em',
      lineHeight: '18px',
      color: TAG_COLOR[tag],
      background: TAG_BG[tag],
      flexShrink: 0,
      minWidth: 36,
      textAlign: 'center' as const,
    }}>
      {tag}
    </span>
  );
}

function LogRow({
  entry,
  expanded,
  onToggle,
}: {
  entry: LogEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  const hasGdg = !!entry.gdgMap;

  return (
    <div style={{ borderBottom: `1px solid ${C.border}` }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 8,
          padding: '5px 12px',
          cursor: hasGdg ? 'pointer' : 'default',
        }}
        onClick={hasGdg ? onToggle : undefined}
      >
        <span style={{ color: C.muted, fontSize: 11, flexShrink: 0, paddingTop: 1 }}>
          {fmtTime(entry.timestamp)}
        </span>
        <TagBadge tag={entry.tag} />
        <span style={{ color: C.text, fontSize: 12, lineHeight: '18px', flex: 1, wordBreak: 'break-word' as const }}>
          {entry.message}
        </span>
        {hasGdg && (
          <span style={{ color: C.teal, fontSize: 11, flexShrink: 0, paddingTop: 1 }}>
            {expanded ? '▼' : '▶'} MAP
          </span>
        )}
        {entry.confidence !== undefined && (
          <span style={{ color: confColor(entry.confidence), fontSize: 11, flexShrink: 0, paddingTop: 1 }}>
            {entry.confidence.toFixed(2)}
          </span>
        )}
        {entry.tier && <TierPill tier={entry.tier} />}
      </div>

      {hasGdg && expanded && (
        <pre style={{
          margin: '0 12px 8px',
          padding: '10px 14px',
          background: '#0c1a19',
          border: `1px solid #0d3d38`,
          borderRadius: 4,
          fontSize: 11,
          lineHeight: 1.6,
          color: '#5eead4',
          overflowX: 'auto' as const,
          whiteSpace: 'pre' as const,
        }}>
          {entry.gdgMap}
        </pre>
      )}
    </div>
  );
}

// ─── Start screen ─────────────────────────────────────────────────────────────

function StartScreen() {
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState<string | null>(null); // sessionId once pipeline completes
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    // Auto-start with Startpage as the default session
    setInput('https://www.startpage.com/');
    handleStart('https://www.startpage.com/');
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Once pipeline completes (ready != null), wait 1.5 s before redirecting.
  // This lets Redis writes propagate before the Mirror starts polling.
  useEffect(() => {
    if (!ready) return;
    const t = setTimeout(() => {
      window.location.href = `/mirror?session=${encodeURIComponent(ready)}`;
    }, 1500);
    return () => clearTimeout(t);
  }, [ready]);

  async function handleStart(override?: string) {
    const value = (override ?? input).trim();
    if (!value || loading || ready) return;
    setLoading(true);
    setError(null);
    try {
      const result = await callPerceive(value);
      // Pipeline complete — session is in Redis. Delay redirect slightly.
      setLoading(false);
      setReady(result.sessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setLoading(false);
    }
  }

  const canSubmit = input.trim().length > 0 && !loading && !ready;

  return (
    <div style={{
      height: '100vh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      background: C.bg,
      fontFamily: C.font,
      gap: 0,
    }}>
      {/* Logo */}
      <div style={{ marginBottom: 48, textAlign: 'center' }}>
        <div style={{ fontSize: 22, fontWeight: 700, color: C.text, letterSpacing: '0.12em' }}>
          HOLLOW
        </div>
        <div style={{ fontSize: 11, color: '#333', marginTop: 6, letterSpacing: '0.06em' }}>
          PERCEPTION ENGINE
        </div>
      </div>

      {/* Input group */}
      <div style={{
        display: 'flex',
        gap: 0,
        width: '100%',
        maxWidth: 560,
        padding: '0 24px',
        boxSizing: 'border-box' as const,
      }}>
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={e => { setInput(e.target.value); setError(null); }}
          onKeyDown={e => e.key === 'Enter' && handleStart()}
          placeholder="https://www.startpage.com/ — or paste raw HTML…"
          disabled={loading}
          style={{
            flex: 1,
            background: '#0f0f0f',
            border: `1px solid ${error ? '#f87171' : '#2a2a2a'}`,
            borderRight: 'none',
            borderRadius: '4px 0 0 4px',
            color: C.text,
            fontFamily: C.font,
            fontSize: 13,
            padding: '10px 14px',
            outline: 'none',
            transition: 'border-color 0.15s',
          }}
        />
        <button
          onClick={() => handleStart()}
          disabled={!canSubmit}
          style={{
            padding: '10px 20px',
            background: canSubmit ? C.tealDim : '#0d0d0d',
            border: `1px solid ${canSubmit ? C.teal : '#1a1a1a'}`,
            borderRadius: '0 4px 4px 0',
            color: canSubmit ? '#5eead4' : '#333',
            fontFamily: C.font,
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.08em',
            textTransform: 'uppercase' as const,
            cursor: canSubmit ? 'pointer' : 'default',
            flexShrink: 0,
            transition: 'all 0.15s',
            whiteSpace: 'nowrap' as const,
          }}
        >
          {loading ? 'Starting…' : 'Start Session'}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div style={{
          marginTop: 12,
          padding: '6px 14px',
          background: '#450a0a',
          border: '1px solid #7f1d1d',
          borderRadius: 4,
          color: '#f87171',
          fontSize: 11,
          maxWidth: 512,
        }}>
          {error}
        </div>
      )}

      {/* Status hints */}
      {loading && (
        <div style={{ marginTop: 16, fontSize: 11, color: '#333', letterSpacing: '0.04em' }}>
          Perceiving… this may take 5–15 seconds on cold start.
        </div>
      )}

      {ready && (
        <div style={{ marginTop: 16, fontSize: 11, color: C.teal, letterSpacing: '0.04em' }}>
          ✓ Session ready — opening Mirror…
        </div>
      )}

      {!loading && !ready && !error && (
        <div style={{ marginTop: 16, fontSize: 10, color: '#252525' }}>
          URL (https://…) or raw HTML accepted · Enter to submit
        </div>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function MatrixMirror({ sessionId }: { sessionId: string | null }) {
  const [status, setStatus] = useState<ConnStatus>('disconnected');
  const [currentUrl, setCurrentUrl] = useState<string>('—');
  const [confidence, setConfidence] = useState<number | null>(null);
  const [tier, setTier] = useState<Tier | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [domHtml, setDomHtml] = useState<string | null>(null);
  const [gdgMap, setGdgMap] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [intervention, setIntervention] = useState('');
  const [staged, setStaged] = useState<string | null>(null);

  // URL navigation bar state
  const [navInput, setNavInput] = useState('');
  const [navLoading, setNavLoading] = useState(false);
  const [navError, setNavError] = useState<string | null>(null);

  // Agent log panel — hidden by default
  const [showLog, setShowLog] = useState(false);

  const logRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Auto-scroll log to bottom
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  // Highlight active element in iframe via postMessage
  useEffect(() => {
    if (activeId === null || !iframeRef.current) return;
    const t = setTimeout(() => {
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'hollow:highlight', id: activeId },
        '*'
      );
    }, 300);
    return () => clearTimeout(t);
  }, [activeId]);

  const addEntry = useCallback((entry: Omit<LogEntry, 'id'>) => {
    const id = uid();
    setLog(prev => {
      // Deduplicate: if a dedupKey is present and we already have an entry with
      // that key, drop the new one. Prevents SSE log_entry + gdg_map events, and
      // SSE + polling, from both adding a GDG row for the same perception step.
      if (entry.dedupKey && prev.some(e => e.dedupKey === entry.dedupKey)) return prev;
      return [...prev, { id, ...entry }];
    });
  }, []);

  // Ghost DOM click interception — links drive Hollow session
  useEffect(() => {
    if (!sessionId) return;
    const handler = async (e: MessageEvent) => {
      if (e.data?.type !== 'hollow-click') return;
      const { hollowId, href, text } = e.data as { hollowId: number | null; href: string | null; text: string };
      if (hollowId) {
        addEntry({ tag: 'ACT', message: `Ghost click → element #${hollowId}${text ? ` "${text}"` : ''}`, timestamp: new Date().toISOString() });
        await callAct(sessionId, { type: 'click', elementId: hollowId });
      } else if (href) {
        const absolute = href.startsWith('http')
          ? href
          : currentUrl !== '—' ? new URL(href, currentUrl).toString() : href;
        addEntry({ tag: 'SYS', message: `Ghost nav → ${absolute}`, timestamp: new Date().toISOString() });
        await callPerceive(absolute, sessionId);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [sessionId, currentUrl, addEntry]);

  // SSE connection + polling fallback
  useEffect(() => {
    if (!sessionId) return;

    setStatus('connecting');
    addEntry({ tag: 'SYS', message: `Connecting to session ${sessionId}…`, timestamp: new Date().toISOString() });

    let hasData = false;
    let pollInterval: ReturnType<typeof setInterval> | null = null;
    let lastUpdatedAt = 0;
    let sseDropLogged = false;       // only log the first SSE drop after data arrives
    let pollingFoundLogged = false;  // only log "session found" once

    function stopPolling() {
      if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
    }

    function startPolling() {
      if (pollInterval) return;
      setStatus('polling');
      addEntry({
        tag: 'SYS',
        message: 'SSE unavailable on this tier — switching to 2s polling fallback.',
        timestamp: new Date().toISOString(),
      });

      pollInterval = setInterval(async () => {
        try {
          const res = await fetch(`/api/session/${sessionId}`);
          if (!res.ok) return; // session not yet in Redis — wait silently
          const d = await res.json();
          if (d.updatedAt === lastUpdatedAt) return;

          // First time polling finds the session: log once
          if (!pollingFoundLogged) {
            pollingFoundLogged = true;
            addEntry({ tag: 'SYS', message: 'Session found. Polling active.', timestamp: new Date().toISOString() });
          }

          lastUpdatedAt = d.updatedAt;

          if (d.html) setDomHtml(d.html);
          if (d.url)  setCurrentUrl(d.url);
          if (d.confidence !== null && d.confidence !== undefined) setConfidence(d.confidence);
          if (d.tier) setTier(d.tier as Tier);
          if (d.gdgMap) setGdgMap(d.gdgMap as string);
          if (d.gdgMap) {
            addEntry({
              tag: 'GDG',
              message: `Perception map updated (step ${d.stepCount}). ${d.tokenEstimate ?? '?'} tokens. Confidence: ${d.confidence?.toFixed(2) ?? '?'}. Tier: ${d.tier ?? '?'}.`,
              timestamp: new Date().toISOString(),
              gdgMap: d.gdgMap,
              confidence: d.confidence,
              tier: d.tier as Tier,
              dedupKey: `gdg:${(d.gdgMap as string).slice(0, 64)}`,
            });
          }
        } catch { /* transient network error — retry next tick */ }
      }, 2000);
    }

    const watchdog = setTimeout(startPolling, 10_000);

    const sse = new EventSource(`/api/stream/${sessionId}`);

    sse.addEventListener('connect', (e: MessageEvent) => {
      const data = JSON.parse(e.data);
      setStatus('connected');
      addEntry({ tag: 'SYS', message: data.message ?? 'Stream connected.', timestamp: new Date().toISOString() });
    });

    sse.addEventListener('log_entry', (e: MessageEvent) => {
      const data = JSON.parse(e.data);
      // Skip GDG log_entry events — the richer gdg_map event for the same
      // perception step always follows and is the canonical GDG log row.
      if (data.tag === 'GDG') return;
      // Suppress repeated server-side "session not found" messages that fire
      // on every SSE reconnect cycle before the first perceive completes.
      // The client already handles this state silently via polling.
      if (typeof data.message === 'string' && /session not found/i.test(data.message)) return;
      addEntry({ tag: data.tag as LogTag, message: data.message, timestamp: data.timestamp ?? new Date().toISOString() });
      if (data.tag === 'ACT' && data.elementId !== undefined) {
        setActiveId(data.elementId as number);
      }
    });

    sse.addEventListener('gdg_map', (e: MessageEvent) => {
      clearTimeout(watchdog);
      stopPolling();
      hasData = true;
      const data = JSON.parse(e.data);
      if (data.confidence !== undefined) setConfidence(data.confidence);
      if (data.tier) setTier(data.tier as Tier);
      if (data.map) setGdgMap(data.map as string);
      addEntry({
        tag: 'GDG',
        message: `Perception map generated. ${data.tokenEstimate ?? '?'} tokens. Confidence: ${data.confidence?.toFixed(2) ?? '?'}. Tier: ${data.tier ?? '?'}.`,
        timestamp: data.timestamp ?? new Date().toISOString(),
        gdgMap: data.map,
        confidence: data.confidence,
        tier: data.tier as Tier,
        // First 64 chars of map content uniquely identify this perception step.
        // Polling may race with SSE — the dedupKey silently drops the duplicate.
        dedupKey: `gdg:${(data.map ?? '').slice(0, 64)}`,
      });
    });

    sse.addEventListener('confidence', (e: MessageEvent) => {
      const data = JSON.parse(e.data);
      setConfidence(data.score);
      setTier(data.tier as Tier);
    });

    sse.addEventListener('dom_delta', (e: MessageEvent) => {
      clearTimeout(watchdog);
      stopPolling();
      hasData = true;
      setStatus('connected');
      const data = JSON.parse(e.data);
      setDomHtml(data.html);
      if (data.url) setCurrentUrl(data.url);
    });

    sse.addEventListener('tier', (e: MessageEvent) => {
      const data = JSON.parse(e.data);
      setTier(data.tier as Tier);
    });

    sse.addEventListener('js_errors', (e: MessageEvent) => {
      const data = JSON.parse(e.data);
      if (Array.isArray(data.errors)) {
        for (const err of data.errors) {
          addEntry({ tag: 'WARN', message: `${err.type}: ${err.message}`, timestamp: new Date().toISOString() });
        }
      }
    });

    sse.addEventListener('reconnect', () => {
      if (!pollInterval) setStatus('connecting');
      addEntry({ tag: 'SYS', message: 'Stream cycling — reconnecting…', timestamp: new Date().toISOString() });
    });

    sse.onerror = () => {
      if (!hasData) {
        // SSE never delivered data — fall back to polling immediately
        clearTimeout(watchdog);
        startPolling();
      } else {
        // SSE dropped after data arrived (normal on Hobby tier — 60s function timeout).
        // Log only the first occurrence; subsequent auto-reconnect cycles are silent.
        setStatus('error');
        if (!sseDropLogged) {
          sseDropLogged = true;
          addEntry({ tag: 'SYS', message: 'SSE stream ended (Hobby tier limit). Polling remains active.', timestamp: new Date().toISOString() });
        }
      }
    };

    return () => {
      clearTimeout(watchdog);
      stopPolling();
      sse.close();
    };
  }, [sessionId, addEntry]);

  // ── URL nav bar handler ────────────────────────────────────────────────────
  async function handleNavigate() {
    const value = navInput.trim();
    if (!value || navLoading || !sessionId) return;
    setNavLoading(true);
    setNavError(null);
    addEntry({ tag: 'SYS', message: `Navigating to: ${value}`, timestamp: new Date().toISOString() });
    try {
      await callPerceive(value, sessionId);
      setNavInput('');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Navigation failed';
      setNavError(msg);
      addEntry({ tag: 'ERR', message: `Navigate failed: ${msg}`, timestamp: new Date().toISOString() });
    } finally {
      setNavLoading(false);
    }
  }

  function toggleExpand(id: string) {
    setExpandedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function submitIntervention() {
    const text = intervention.trim();
    if (!text || !sessionId) return;
    setStaged(text);
    setIntervention('');
    addEntry({ tag: 'SYS', message: `Intervention staged: "${text}"`, timestamp: new Date().toISOString() });

    fetch('/api/stage-intervention', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, text }),
    }).catch(() => {});
  }

  // ─── No session — show start screen ───────────────────────────────────────
  if (!sessionId) {
    return <StartScreen />;
  }

  // ─── Active mirror ─────────────────────────────────────────────────────────
  const shortSession = sessionId.replace(/^sess:/, '').slice(0, 8) + '…';

  return (
    <div style={{
      height: '100vh',
      display: 'flex',
      flexDirection: 'column',
      background: C.bg,
      fontFamily: C.font,
      color: C.text,
      overflow: 'hidden',
    }}>

      {/* ── Top bar ───────────────────────────────────────────────────────── */}
      <div style={{
        height: 48,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '0 12px',
        borderBottom: `1px solid ${C.border}`,
        background: C.panel,
        flexShrink: 0,
      }}>
        {/* Logo */}
        <span style={{ fontSize: 13, fontWeight: 700, color: C.text, letterSpacing: '0.04em', flexShrink: 0 }}>
          HOLLOW
        </span>

        <span style={{ color: C.border, fontSize: 18, lineHeight: 1 }}>|</span>

        {/* URL navigation bar */}
        <div style={{ display: 'flex', flex: 1, gap: 0, minWidth: 0 }}>
          <input
            type="text"
            value={navInput}
            onChange={e => { setNavInput(e.target.value); setNavError(null); }}
            onKeyDown={e => e.key === 'Enter' && handleNavigate()}
            placeholder={currentUrl === '—' ? 'https://www.startpage.com/ or paste HTML…' : currentUrl}
            disabled={navLoading}
            style={{
              flex: 1,
              minWidth: 0,
              background: navError ? '#1a0505' : '#0a0a0a',
              border: `1px solid ${navError ? '#7f1d1d' : '#1e1e1e'}`,
              borderRight: 'none',
              borderRadius: '3px 0 0 3px',
              color: C.text,
              fontFamily: C.font,
              fontSize: 11,
              padding: '4px 10px',
              outline: 'none',
            }}
          />
          <button
            onClick={handleNavigate}
            disabled={!navInput.trim() || navLoading}
            style={{
              padding: '4px 12px',
              background: navInput.trim() && !navLoading ? C.tealDim : 'transparent',
              border: `1px solid ${navInput.trim() && !navLoading ? C.teal : '#1e1e1e'}`,
              borderRadius: '0 3px 3px 0',
              color: navInput.trim() && !navLoading ? '#5eead4' : '#333',
              fontFamily: C.font,
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.06em',
              textTransform: 'uppercase' as const,
              cursor: navInput.trim() && !navLoading ? 'pointer' : 'default',
              flexShrink: 0,
              whiteSpace: 'nowrap' as const,
            }}
          >
            {navLoading ? '…' : 'Go'}
          </button>
        </div>

        <span style={{ color: C.border, fontSize: 18, lineHeight: 1 }}>|</span>

        {/* Session ID */}
        <span style={{ fontSize: 10, color: '#444', flexShrink: 0 }}>
          sess:{shortSession}
        </span>

        <span style={{ color: C.border, fontSize: 18, lineHeight: 1 }}>|</span>

        {/* Confidence */}
        {confidence !== null && (
          <span style={{ fontSize: 12, fontWeight: 700, color: confColor(confidence), flexShrink: 0 }}>
            {confidence.toFixed(2)}
          </span>
        )}

        {/* Tier */}
        <TierPill tier={tier} />

        <span style={{ color: C.border, fontSize: 18, lineHeight: 1 }}>|</span>

        {/* Connection status */}
        <StatusDot status={status} />

        <span style={{ color: C.border, fontSize: 18, lineHeight: 1 }}>|</span>

        {/* QR session connector */}
        <QRConnector sessionId={sessionId} />
      </div>

      {/* ── Main panels ───────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

        {/* Left — Ghost DOM / Component Tree viewer */}
        <div style={{
          width: showLog ? '45%' : '100%',
          borderRight: showLog ? `1px solid ${C.border}` : 'none',
          display: 'flex',
          flexDirection: 'column',
          flexShrink: 0,
          position: 'relative',
        }}>
          <div style={{
            height: 32,
            display: 'flex',
            alignItems: 'center',
            padding: '0 12px',
            borderBottom: `1px solid ${C.border}`,
            background: C.panel,
            flexShrink: 0,
          }}>
            <span style={{ fontSize: 10, color: '#444', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
              {tier === 'vdom' ? 'Component Tree' : tier === 'mobile-api' ? 'API Map' : 'Ghost DOM'}
            </span>
            {(tier === 'vdom' || tier === 'mobile-api' ? gdgMap : domHtml) && (
              <span style={{ marginLeft: 'auto', fontSize: 10, color: tier === 'vdom' ? '#a78bfa' : tier === 'mobile-api' ? '#60a5fa' : C.teal }}>● LIVE</span>
            )}
          </div>

          {/* Floating inspect button */}
          <button
            onClick={() => setShowLog(v => !v)}
            title={showLog ? 'Close agent log' : 'Open agent log'}
            style={{
              position: 'absolute',
              top: 6,
              right: 10,
              zIndex: 10,
              background: showLog ? C.tealDim : '#111',
              border: `1px solid ${showLog ? C.teal : '#333'}`,
              borderRadius: 4,
              color: showLog ? '#5eead4' : '#555',
              fontFamily: C.font,
              fontSize: 10,
              fontWeight: 700,
              padding: '2px 8px',
              cursor: 'pointer',
              letterSpacing: '0.08em',
            }}
          >
            {showLog ? '✕ LOG' : '⌥ LOG'}
          </button>

          {tier === 'vdom' || tier === 'mobile-api' ? (
            gdgMap ? (
              <pre style={{
                flex: 1,
                margin: 0,
                padding: '12px 14px',
                overflowY: 'auto',
                background: C.bg,
                color: tier === 'mobile-api' ? '#93c5fd' : '#c4b5fd',
                fontSize: 11,
                lineHeight: 1.6,
                fontFamily: C.font,
                whiteSpace: 'pre',
              }}>
                {gdgMap}
              </pre>
            ) : (
              <div style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 10,
                color: '#2a2a2a',
              }}>
                <span style={{ fontSize: 28 }}>◻</span>
                <span style={{ fontSize: 11 }}>Waiting for component tree…</span>
              </div>
            )
          ) : domHtml ? (
            <iframe
              ref={iframeRef}
              srcDoc={injectHollowScript(domHtml, currentUrl)}
              sandbox="allow-scripts"
              style={{ flex: 1, border: 'none', background: '#fff', width: '100%' }}
            />
          ) : (
            <div style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 10,
              color: '#2a2a2a',
            }}>
              <span style={{ fontSize: 28 }}>◻</span>
              <span style={{ fontSize: 11 }}>Waiting for DOM delta…</span>
            </div>
          )}
        </div>

        {/* Right — Agent log */}
        {showLog && <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{
            height: 32,
            display: 'flex',
            alignItems: 'center',
            padding: '0 12px',
            borderBottom: `1px solid ${C.border}`,
            background: C.panel,
            flexShrink: 0,
            gap: 8,
          }}>
            <span style={{ fontSize: 10, color: '#444', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
              Agent Log
            </span>
            <span style={{ fontSize: 10, color: '#333' }}>
              {log.length} entries
            </span>
            {staged && (
              <span style={{
                marginLeft: 'auto',
                fontSize: 10,
                color: '#fbbf24',
                background: '#431407',
                padding: '1px 6px',
                borderRadius: 3,
              }}>
                ⚡ intervention staged
              </span>
            )}
          </div>

          <div ref={logRef} style={{ flex: 1, overflowY: 'auto', fontSize: 12 }}>
            {log.length === 0 ? (
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                height: '100%', color: '#2a2a2a', fontSize: 11,
              }}>
                Stream connected — waiting for agent activity…
              </div>
            ) : (
              log.map(entry => (
                <LogRow
                  key={entry.id}
                  entry={entry}
                  expanded={expandedIds.has(entry.id)}
                  onToggle={() => toggleExpand(entry.id)}
                />
              ))
            )}
          </div>
        </div>}
      </div>

      {/* ── Bottom bar — Intervention ──────────────────────────────────────── */}
      <div style={{
        height: 56,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '0 16px',
        borderTop: `1px solid ${C.border}`,
        background: C.panel,
        flexShrink: 0,
      }}>
        <span style={{ fontSize: 10, color: '#444', letterSpacing: '0.08em', textTransform: 'uppercase', flexShrink: 0 }}>
          Intervention
        </span>
        <span style={{ color: C.borderMid, fontSize: 16, lineHeight: 1 }}>›</span>
        <input
          type="text"
          value={intervention}
          onChange={e => setIntervention(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && submitIntervention()}
          placeholder="Type instruction for next agent step…"
          style={{
            flex: 1,
            background: '#111',
            border: `1px solid ${C.borderMid}`,
            borderRadius: 4,
            color: C.text,
            fontFamily: C.font,
            fontSize: 12,
            padding: '6px 10px',
            outline: 'none',
          }}
        />
        <button
          onClick={submitIntervention}
          disabled={!intervention.trim()}
          style={{
            padding: '6px 16px',
            background: intervention.trim() ? C.tealDim : '#111',
            border: `1px solid ${intervention.trim() ? C.teal : C.borderMid}`,
            borderRadius: 4,
            color: intervention.trim() ? '#5eead4' : '#444',
            fontFamily: C.font,
            fontSize: 11,
            fontWeight: 700,
            cursor: intervention.trim() ? 'pointer' : 'default',
            letterSpacing: '0.06em',
            textTransform: 'uppercase' as const,
            flexShrink: 0,
          }}
        >
          Stage
        </button>
      </div>
    </div>
  );
}
