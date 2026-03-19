'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

type LogTag = 'SYS' | 'GDG' | 'AI' | 'ACT' | 'OK' | 'WARN' | 'ERR';
type Tier = 'hollow' | 'baas';
type ConnStatus = 'disconnected' | 'connecting' | 'connected' | 'polling' | 'error';

interface LogEntry {
  id: string;
  tag: LogTag;
  message: string;
  timestamp: string;
  gdgMap?: string;
  confidence?: number;
  tier?: Tier;
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

// Inject badge + highlight script into Ghost DOM HTML
function injectHollowScript(html: string): string {
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
      b.style.cssText='position:absolute;top:-9px;left:0;background:#0d9488;color:#fff;'+
        'font:700 9px/1 monospace;padding:1px 4px;border-radius:2px;z-index:2147483647;'+
        'pointer-events:none;white-space:nowrap;';
      var s=window.getComputedStyle(el);
      if(s.position==='static')el.style.position='relative';
      el.style.zIndex=el.style.zIndex||'1';
      el.appendChild(b);
    });
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
  if (html.includes('</body>')) return html.replace('</body>', script + '</body>');
  return html + script;
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

function TierPill({ tier }: { tier: Tier | null }) {
  if (!tier) return null;
  const hollow = tier === 'hollow';
  return (
    <span style={{
      padding: '2px 8px',
      borderRadius: '4px',
      fontSize: '10px',
      fontWeight: 700,
      letterSpacing: '0.1em',
      textTransform: 'uppercase' as const,
      background: hollow ? '#052e16' : '#431407',
      color: hollow ? '#4ade80' : '#fb923c',
      border: `1px solid ${hollow ? '#166534' : '#92400e'}`,
    }}>
      {tier}
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
        {/* Time */}
        <span style={{ color: C.muted, fontSize: 11, flexShrink: 0, paddingTop: 1 }}>
          {fmtTime(entry.timestamp)}
        </span>

        {/* Tag */}
        <TagBadge tag={entry.tag} />

        {/* Message */}
        <span style={{ color: C.text, fontSize: 12, lineHeight: '18px', flex: 1, wordBreak: 'break-word' as const }}>
          {entry.message}
        </span>

        {/* GDG expand toggle */}
        {hasGdg && (
          <span style={{ color: C.teal, fontSize: 11, flexShrink: 0, paddingTop: 1 }}>
            {expanded ? '▼' : '▶'} MAP
          </span>
        )}

        {/* Confidence + tier on GDG rows */}
        {entry.confidence !== undefined && (
          <span style={{ color: confColor(entry.confidence), fontSize: 11, flexShrink: 0, paddingTop: 1 }}>
            {entry.confidence.toFixed(2)}
          </span>
        )}
        {entry.tier && <TierPill tier={entry.tier} />}
      </div>

      {/* GDG map collapsible */}
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

// ─── Main component ───────────────────────────────────────────────────────────

export function MatrixMirror({ sessionId }: { sessionId: string | null }) {
  const [status, setStatus] = useState<ConnStatus>('disconnected');
  const [url, setUrl] = useState<string>('—');
  const [confidence, setConfidence] = useState<number | null>(null);
  const [tier, setTier] = useState<Tier | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [domHtml, setDomHtml] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [intervention, setIntervention] = useState('');
  const [staged, setStaged] = useState<string | null>(null);

  const logRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const counterRef = useRef(0);

  // Auto-scroll log to bottom
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  // Update Ghost DOM iframe
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || !domHtml) return;
    iframe.srcdoc = injectHollowScript(domHtml);
  }, [domHtml]);

  // Highlight active element in iframe via postMessage
  useEffect(() => {
    if (activeId === null || !iframeRef.current) return;
    // Small delay to let iframe script initialise after a dom_delta reload
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
    setLog(prev => [...prev, { id, ...entry }]);
  }, []);

  // SSE connection + polling fallback
  useEffect(() => {
    if (!sessionId) return;

    setStatus('connecting');
    addEntry({ tag: 'SYS', message: `Connecting to session ${sessionId}…`, timestamp: new Date().toISOString() });

    // Track whether any substantive data has arrived via SSE
    let hasData = false;

    // ── Polling fallback ──────────────────────────────────────────────────────
    // Activated when SSE times out or errors before delivering any events.
    let pollInterval: ReturnType<typeof setInterval> | null = null;
    let lastUpdatedAt = 0;

    function stopPolling() {
      if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
    }

    function startPolling() {
      if (pollInterval) return; // already running
      setStatus('polling');
      addEntry({
        tag: 'SYS',
        message: 'SSE unavailable on this tier — switching to 2s polling fallback.',
        timestamp: new Date().toISOString(),
      });

      pollInterval = setInterval(async () => {
        try {
          const res = await fetch(`/api/session/${sessionId}`);
          if (!res.ok) return;
          const d = await res.json();
          if (d.updatedAt === lastUpdatedAt) return; // nothing changed
          lastUpdatedAt = d.updatedAt;

          if (d.html) setDomHtml(d.html);
          if (d.url)  setUrl(d.url);
          if (d.confidence !== null && d.confidence !== undefined) setConfidence(d.confidence);
          if (d.tier) setTier(d.tier as Tier);
          if (d.gdgMap) {
            addEntry({
              tag: 'GDG',
              message: `Perception map updated (step ${d.stepCount}). ${d.tokenEstimate ?? '?'} tokens. Confidence: ${d.confidence?.toFixed(2) ?? '?'}. Tier: ${d.tier ?? '?'}.`,
              timestamp: new Date().toISOString(),
              gdgMap: d.gdgMap,
              confidence: d.confidence,
              tier: d.tier as Tier,
            });
          }
        } catch { /* transient network error — retry next tick */ }
      }, 2000);
    }

    // If no dom_delta arrives within 10 s of connecting, fall back to polling.
    const watchdog = setTimeout(startPolling, 10_000);

    // ── SSE ───────────────────────────────────────────────────────────────────
    const sse = new EventSource(`/api/stream/${sessionId}`);

    sse.addEventListener('connect', (e: MessageEvent) => {
      const data = JSON.parse(e.data);
      setStatus('connected');
      addEntry({ tag: 'SYS', message: data.message ?? 'Stream connected.', timestamp: new Date().toISOString() });
    });

    sse.addEventListener('log_entry', (e: MessageEvent) => {
      const data = JSON.parse(e.data);
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
      addEntry({
        tag: 'GDG',
        message: `Perception map generated. ${data.tokenEstimate ?? '?'} tokens. Confidence: ${data.confidence?.toFixed(2) ?? '?'}. Tier: ${data.tier ?? '?'}.`,
        timestamp: data.timestamp ?? new Date().toISOString(),
        gdgMap: data.map,
        confidence: data.confidence,
        tier: data.tier as Tier,
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
      if (data.url) setUrl(data.url);
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

    // Stream self-closes every 55 s in production (poll_timeout).
    // EventSource reconnects automatically; if polling is active it stays active.
    sse.addEventListener('reconnect', () => {
      if (!pollInterval) setStatus('connecting');
      addEntry({ tag: 'SYS', message: 'Stream cycling — reconnecting…', timestamp: new Date().toISOString() });
    });

    sse.onerror = () => {
      if (!hasData) {
        // SSE failed before delivering any data — start polling immediately
        clearTimeout(watchdog);
        startPolling();
      } else {
        setStatus('error');
        addEntry({ tag: 'ERR', message: 'SSE connection lost.', timestamp: new Date().toISOString() });
      }
    };

    return () => {
      clearTimeout(watchdog);
      stopPolling();
      sse.close();
    };
  }, [sessionId, addEntry]);

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

  // ─── No session state ──────────────────────────────────────────────────────
  if (!sessionId) {
    return (
      <div style={{
        height: '100vh', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        background: C.bg, color: C.muted, fontFamily: C.font, gap: 16,
      }}>
        <span style={{ fontSize: 13 }}>No session ID.</span>
        <span style={{ fontSize: 11, color: '#333' }}>
          Navigate to <code style={{ color: '#555' }}>/mirror?session=&lt;sessionId&gt;</code>
        </span>
        <span style={{ fontSize: 11, color: '#2a2a2a', marginTop: 8 }}>
          Start a session: <code style={{ color: '#333' }}>POST /api/perceive {'{'} url, html {'}'}</code>
        </span>
      </div>
    );
  }

  // ─── Render ────────────────────────────────────────────────────────────────
  const shortSession = sessionId.slice(0, 8) + '…';

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

      {/* ── Top bar ────────────────────────────────────────────────────────── */}
      <div style={{
        height: 48,
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        padding: '0 16px',
        borderBottom: `1px solid ${C.border}`,
        background: C.panel,
        flexShrink: 0,
      }}>
        {/* Logo */}
        <span style={{ fontSize: 13, fontWeight: 700, color: C.text, letterSpacing: '0.04em', marginRight: 4 }}>
          HOLLOW
        </span>

        <span style={{ color: C.border, fontSize: 18, lineHeight: 1 }}>|</span>

        {/* URL */}
        <span style={{
          fontSize: 11, color: '#888',
          maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {url}
        </span>

        {/* Session */}
        <span style={{ fontSize: 10, color: '#444', marginLeft: 'auto' }}>
          sess:{shortSession}
        </span>

        <span style={{ color: C.border, fontSize: 18, lineHeight: 1 }}>|</span>

        {/* Confidence */}
        {confidence !== null && (
          <span style={{ fontSize: 12, fontWeight: 700, color: confColor(confidence) }}>
            {confidence.toFixed(2)}
          </span>
        )}

        {/* Tier */}
        <TierPill tier={tier} />

        <span style={{ color: C.border, fontSize: 18, lineHeight: 1 }}>|</span>

        {/* Connection status */}
        <StatusDot status={status} />
      </div>

      {/* ── Main panels ────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

        {/* Left — Ghost DOM viewer */}
        <div style={{
          width: '45%',
          borderRight: `1px solid ${C.border}`,
          display: 'flex',
          flexDirection: 'column',
          flexShrink: 0,
        }}>
          {/* Panel header */}
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
              Ghost DOM
            </span>
            {domHtml && (
              <span style={{ marginLeft: 'auto', fontSize: 10, color: C.teal }}>● LIVE</span>
            )}
          </div>

          {/* Iframe / empty state */}
          {domHtml ? (
            <iframe
              ref={iframeRef}
              sandbox="allow-scripts"
              style={{
                flex: 1,
                border: 'none',
                background: '#fff',
                width: '100%',
              }}
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
              <span style={{ fontSize: 10, color: '#222' }}>
                POST /api/perceive to populate
              </span>
            </div>
          )}
        </div>

        {/* Right — Agent log */}
        <div style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}>
          {/* Panel header */}
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

          {/* Scrollable log */}
          <div
            ref={logRef}
            style={{
              flex: 1,
              overflowY: 'auto',
              fontSize: 12,
            }}
          >
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
        </div>
      </div>

      {/* ── Bottom bar — Intervention ───────────────────────────────────────── */}
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
