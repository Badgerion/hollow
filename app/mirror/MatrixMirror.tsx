'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

/* ─── Types ──────────────────────────────────────────────────────────────────── */

type LogTag = 'SYS' | 'GDG' | 'AI' | 'ACT' | 'OK' | 'WARN' | 'ERR';
type Tier = 'hollow' | 'partial' | 'vdom' | 'mobile-api' | 'cache' | 'text';
type ConnStatus = 'disconnected' | 'connecting' | 'connected' | 'polling' | 'error';

interface SessionTabEntry {
  sessionId: string;
  url: string;
  tier: Tier | null;
  confidence: number | null;
  updatedAt: number;
}

interface LogEntry {
  id: string;
  tag: LogTag;
  message: string;
  timestamp: string;
  gdgMap?: string;
  confidence?: number;
  tier?: Tier;
  dedupKey?: string;
}

/* ─── Design tokens ──────────────────────────────────────────────────────────── */

const FONT = `'JetBrains Mono', 'Berkeley Mono', 'IBM Plex Mono', monospace`;

const TIER_STYLE: Record<string, { text: string; bg: string }> = {
  hollow:       { text: '#27c93f', bg: 'rgba(39,201,63,0.12)' },
  vdom:         { text: '#9b5de5', bg: 'rgba(155,93,229,0.12)' },
  text:         { text: '#0ea5e9', bg: 'rgba(14,165,233,0.12)' },
  cache:        { text: '#f59e0b', bg: 'rgba(245,158,11,0.12)' },
  'mobile-api': { text: '#3b82f6', bg: 'rgba(59,130,246,0.12)' },
  partial:      { text: '#ff5f56', bg: 'rgba(255,95,86,0.12)' },
};

const TAG_STYLE: Record<LogTag, { text: string; bg: string }> = {
  SYS:  { text: 'rgba(255,255,255,0.4)',  bg: 'transparent' },
  GDG:  { text: '#818cf8',               bg: 'rgba(129,140,248,0.08)' },
  AI:   { text: '#34d399',               bg: 'rgba(52,211,153,0.08)' },
  ACT:  { text: '#60a5fa',               bg: 'rgba(96,165,250,0.08)' },
  OK:   { text: '#34d399',               bg: 'transparent' },
  WARN: { text: '#fbbf24',               bg: 'transparent' },
  ERR:  { text: '#f87171',               bg: 'transparent' },
};

/* ─── Utilities ──────────────────────────────────────────────────────────────── */

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('en-US', {
      hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch { return '--:--:--'; }
}

function confColor(s: number) {
  return s >= 0.8 ? '#27c93f' : s >= 0.5 ? '#ff9f0a' : '#ff5f56';
}

function uid() { return `${Date.now()}-${Math.random().toString(36).slice(2)}`; }

function looksLikeUrl(s: string) {
  const t = s.trim();
  return t.startsWith('http://') || t.startsWith('https://');
}

function injectHollowScript(html: string, sessionUrl?: string): string {
  const baseTag = sessionUrl && sessionUrl !== '—' ? `<base href="${sessionUrl}">` : '';
  const script = `<script>
(function(){
  var SEL='a[href],button,input,select,textarea,[role="button"],[onclick],[tabindex]:not([tabindex="-1"])';
  function init(){
    var els=Array.from(document.querySelectorAll(SEL));
    els.forEach(function(el,i){
      var r=el.getBoundingClientRect();if(r.width===0&&r.height===0)return;
      var b=document.createElement('span');
      b.textContent=i+1;b.setAttribute('data-hid',i+1);b.setAttribute('data-hollow-id',i+1);
      el.setAttribute('data-hollow-id',i+1);
      b.style.cssText='position:absolute;top:-9px;left:0;background:#0d9488;color:#fff;font:700 9px/1 monospace;padding:1px 4px;border-radius:2px;z-index:2147483647;pointer-events:none;white-space:nowrap;';
      var s=window.getComputedStyle(el);
      if(s.position==='static')el.style.position='relative';
      el.style.zIndex=el.style.zIndex||'1';el.appendChild(b);
    });
    document.addEventListener('click',function(e){
      var el=e.target.closest('a,button,[role="button"]');if(!el)return;
      var hollowId=el.dataset&&el.dataset.hollowId?parseInt(el.dataset.hollowId):null;
      var href=el.getAttribute('href')||null;
      if(!hollowId&&!href)return;
      e.preventDefault();
      window.parent.postMessage({type:'hollow-click',hollowId:hollowId,href:href,text:(el.textContent||'').trim().slice(0,80)},'*');
    },true);
    window.addEventListener('message',function(e){
      if(!e.data||e.data.type!=='hollow:highlight')return;
      document.querySelectorAll('[data-hollow-active]').forEach(function(el){el.removeAttribute('data-hollow-active');el.style.outline='';el.style.outlineOffset='';});
      var t=els[e.data.id-1];
      if(t){t.setAttribute('data-hollow-active','1');t.style.outline='2px solid #0d9488';t.style.outlineOffset='2px';t.scrollIntoView({behavior:'smooth',block:'center'});}
    });
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
<\/script>`;
  let result = html;
  if (baseTag) {
    if (result.includes('</head>')) result = result.replace('</head>', baseTag + '</head>');
    else if (result.includes('<head>')) result = result.replace('<head>', '<head>' + baseTag);
    else result = baseTag + result;
  }
  if (result.includes('</body>')) return result.replace('</body>', script + '</body>');
  return result + script;
}

/* ─── API helpers ────────────────────────────────────────────────────────────── */

async function callPerceive(input: string, sessionId?: string): Promise<{ sessionId: string }> {
  const body: Record<string, string> = looksLikeUrl(input) ? { url: input.trim() } : { html: input.trim() };
  if (sessionId) body.sessionId = sessionId;
  const res = await fetch('/api/perceive', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json as { sessionId: string };
}

async function callAct(sessionId: string, action: { type: string; elementId?: number; url?: string }): Promise<void> {
  await fetch('/api/act', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, action }),
  });
}

/* ─── HollowMark ─────────────────────────────────────────────────────────────── */

function HollowMark({ size = 16, opacity = 1, stroke = 1.5 }: { size?: number; opacity?: number; stroke?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ opacity, flexShrink: 0, display: 'block' }}>
      <path d="M6 22 C2 15 3 7 11.5 3.5" stroke="white" strokeWidth={stroke} strokeLinecap="round" />
      <path d="M18 22 C22 15 21 7 12.5 3.5" stroke="white" strokeWidth={stroke} strokeLinecap="round" />
    </svg>
  );
}

/* ─── Wallpaper ──────────────────────────────────────────────────────────────── */

function Wallpaper() {
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 0, background: '#0d0d1a', overflow: 'hidden' }}>
      {/* Dither noise */}
      <div style={{
        position: 'absolute', inset: 0, pointerEvents: 'none',
        backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='4' height='4'%3E%3Crect x='0' y='0' width='1' height='1' fill='%23fff' fill-opacity='0.018'/%3E%3Crect x='2' y='2' width='1' height='1' fill='%23fff' fill-opacity='0.018'/%3E%3Crect x='0' y='2' width='1' height='1' fill='%23fff' fill-opacity='0.008'/%3E%3Crect x='2' y='0' width='1' height='1' fill='%23fff' fill-opacity='0.008'/%3E%3C/svg%3E")`,
      }} />
      {/* Sky glow */}
      <div style={{
        position: 'absolute', inset: 0, pointerEvents: 'none',
        background: 'radial-gradient(ellipse 70% 50% at 50% 0%, rgba(15,52,96,0.5) 0%, transparent 70%)',
      }} />
      {/* Moon */}
      <div style={{
        position: 'absolute', top: 44, right: 88,
        width: 7, height: 7, borderRadius: '50%',
        background: '#ddddc8',
        boxShadow: '0 0 14px 3px rgba(220,220,200,0.25)',
      }} />
      {/* Far hills — #1a1a2e */}
      <svg style={{ position: 'absolute', bottom: 0, left: 0, width: '100%', height: '44%' }}
        viewBox="0 0 1440 390" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M0 390 L0 210 Q80 195 160 205 Q280 218 400 195 Q520 172 640 188 Q760 204 880 180 Q1000 156 1120 170 Q1240 184 1360 168 Q1400 163 1440 165 L1440 390 Z" fill="#1a1a2e" />
      </svg>
      {/* Mid hills — #16213e */}
      <svg style={{ position: 'absolute', bottom: 0, left: 0, width: '100%', height: '35%' }}
        viewBox="0 0 1440 315" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M0 315 L0 175 Q100 148 220 165 Q380 186 520 158 Q660 130 800 150 Q940 170 1080 145 Q1220 120 1320 138 Q1380 147 1440 140 L1440 315 Z" fill="#16213e" />
      </svg>
      {/* Near hills — #0f3460 */}
      <svg style={{ position: 'absolute', bottom: 0, left: 0, width: '100%', height: '26%' }}
        viewBox="0 0 1440 234" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M0 234 L0 130 Q60 108 140 120 Q240 135 340 112 Q440 89 540 105 Q640 121 740 100 Q840 79 960 95 Q1080 111 1180 94 Q1300 75 1380 88 Q1420 95 1440 92 L1440 234 Z" fill="#0f3460" />
      </svg>
    </div>
  );
}

/* ─── MenuBar ────────────────────────────────────────────────────────────────── */

function MenuBar() {
  const [clock, setClock] = useState('');
  useEffect(() => {
    function tick() {
      const n = new Date();
      const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      const h = n.getHours() % 12 || 12;
      const m = n.getMinutes().toString().padStart(2, '0');
      setClock(`${days[n.getDay()]} ${months[n.getMonth()]} ${n.getDate()}  ${h}:${m} ${n.getHours() >= 12 ? 'PM' : 'AM'}`);
    }
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, []);

  const bar: React.CSSProperties = {
    position: 'fixed', top: 0, left: 0, right: 0, height: 24, zIndex: 200,
    background: 'rgba(0,0,0,0.75)',
    backdropFilter: 'blur(20px)',
    display: 'flex', alignItems: 'center',
    padding: '0 12px',
    fontFamily: FONT, fontSize: 11, color: 'white',
    userSelect: 'none',
  };

  return (
    <div style={bar}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
        {/* Apple mark */}
        <svg width="12" height="15" viewBox="0 0 12 15" fill="white" style={{ opacity: 0.9 }}>
          <path d="M10.8 10.2c-.3.6-.5 1.1-.9 1.6-.5.7-.9 1.1-1.3 1.1-.3 0-.7-.1-1.3-.4-.5-.2-.9-.3-1.3-.3s-.8.1-1.3.3c-.5.2-.9.4-1.2.4-.4 0-.8-.4-1.3-1.1-.5-.7-.9-1.5-1.2-2.5C1 8.4.8 7.3.8 6.2c0-1.1.2-2 .7-2.8.4-.6.9-1.1 1.6-1.4.7-.3 1.4-.5 2.1-.5.4 0 1 .1 1.7.4.6.2 1 .3 1.1.3.1 0 .6-.1 1.3-.4.6-.2 1.2-.4 1.7-.3 1.2.1 2.1.6 2.7 1.6-.5.3-.9.7-1.1 1.2-.2.5-.4 1.1-.4 1.7 0 .6.2 1.2.5 1.8.3.5.7.8 1.2 1-.1.3-.3.7-.4 1.1zM7.9 1.2C7.9 1.7 7.7 2.2 7.3 2.7c-.5.5-.9.8-1.6.7 0-.1 0-.1 0-.2 0-.5.2-1 .6-1.4.2-.2.5-.4.7-.6.3-.1.6-.2.8-.2 0 0 0 .1 0 .2z" />
        </svg>
        <span style={{ fontWeight: 700 }}>Hollow</span>
        {['File','View','Window'].map(x => (
          <span key={x} style={{ color: 'rgba(255,255,255,0.8)', cursor: 'default' }}>{x}</span>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {/* Wifi */}
        <svg width="16" height="12" viewBox="0 0 16 12" fill="none">
          <circle cx="8" cy="10.5" r="1.2" fill="white" fillOpacity="0.9" />
          <path d="M4.5 7.5 Q8 5 11.5 7.5" stroke="white" strokeOpacity="0.9" strokeWidth="1.2" strokeLinecap="round" fill="none" />
          <path d="M2 5 Q8 1.5 14 5" stroke="white" strokeOpacity="0.75" strokeWidth="1.2" strokeLinecap="round" fill="none" />
          <path d="M0 2.5 Q8 -1.5 16 2.5" stroke="white" strokeOpacity="0.5" strokeWidth="1.2" strokeLinecap="round" fill="none" />
        </svg>
        {/* Battery ~80% */}
        <svg width="23" height="12" viewBox="0 0 23 12" fill="none">
          <rect x="0.5" y="1.5" width="19" height="9" rx="2" stroke="white" strokeOpacity="0.55" strokeWidth="1" />
          <rect x="19.5" y="4" width="3" height="4" rx="1" fill="white" fillOpacity="0.45" />
          <rect x="1.5" y="2.5" width="14.5" height="7" rx="1.5" fill="white" fillOpacity="0.85" />
        </svg>
        <span style={{ letterSpacing: '0.02em', color: 'rgba(255,255,255,0.9)' }}>{clock}</span>
      </div>
    </div>
  );
}

/* ─── Dock ───────────────────────────────────────────────────────────────────── */

function Dock({ active }: { active: boolean }) {
  const [hov, setHov] = useState<number | null>(null);
  const scale = (i: number) => {
    if (hov === null) return 1;
    const d = Math.abs(i - hov);
    return d === 0 ? 1.25 : d === 1 ? 1.1 : 1;
  };

  const icons = [
    {
      label: 'Hollow', showDot: active,
      el: (
        <div style={{ width: 52, height: 52, borderRadius: 12, background: '#0a0a0a', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.07), 0 2px 8px rgba(0,0,0,0.6)' }}>
          <HollowMark size={30} />
        </div>
      ),
    },
    {
      label: 'Terminal', showDot: false,
      el: (
        <div style={{ width: 52, height: 52, borderRadius: 12, background: '#1c1c1e', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05), 0 2px 8px rgba(0,0,0,0.6)' }}>
          <span style={{ fontFamily: FONT, fontSize: 14, color: '#00ff41', fontWeight: 500, letterSpacing: '-0.02em' }}>{'> _'}</span>
        </div>
      ),
    },
  ];

  return (
    <div style={{ position: 'fixed', bottom: 14, left: 0, right: 0, zIndex: 200, display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}>
      <div style={{
        background: 'rgba(255,255,255,0.12)',
        backdropFilter: 'blur(40px)',
        border: '1px solid rgba(255,255,255,0.2)',
        borderRadius: 16,
        padding: '8px 12px',
        display: 'flex', gap: 12, alignItems: 'flex-end',
        pointerEvents: 'all',
      }}>
        {icons.map((icon, i) => (
          <div
            key={icon.label}
            onMouseEnter={() => setHov(i)}
            onMouseLeave={() => setHov(null)}
            style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
              cursor: 'default',
              transform: `scale(${scale(i)})`,
              transformOrigin: 'bottom center',
              transition: 'transform 0.12s ease',
            }}
          >
            {icon.el}
            <div style={{ height: 5, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {icon.showDot && <div style={{ width: 4, height: 4, borderRadius: '50%', background: 'rgba(255,255,255,0.75)' }} />}
            </div>
            <span style={{ fontFamily: FONT, fontSize: 10, color: 'rgba(255,255,255,0.65)' }}>{icon.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── StartPanel ─────────────────────────────────────────────────────────────── */

function StartPanel() {
  const [input, setInput] = useState('https://');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);

  async function go() {
    const v = input.trim();
    if (!v || v === 'https://' || loading) return;
    setLoading(true); setError(null);
    try {
      const r = await callPerceive(v);
      window.location.href = `/mirror?session=${encodeURIComponent(r.sessionId)}`;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
      setLoading(false);
    }
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: 'white', gap: 12, fontFamily: FONT }}>
      <HollowMark size={48} opacity={0.25} />
      <span style={{ fontSize: 13, color: 'rgba(0,0,0,0.2)', letterSpacing: '0.3em' }}>hollow</span>
      <div style={{ display: 'flex', width: 400, marginTop: 8 }}>
        <input
          ref={ref}
          value={input}
          onChange={e => { setInput(e.target.value); setError(null); }}
          onKeyDown={e => e.key === 'Enter' && go()}
          placeholder="enter a url…"
          disabled={loading}
          style={{
            flex: 1, height: 36, background: '#f5f5f5',
            border: `1px solid ${error ? '#f87171' : '#ddd'}`,
            borderRight: 'none', borderRadius: '6px 0 0 6px',
            padding: '0 12px', fontFamily: FONT, fontSize: 12, color: '#111', outline: 'none',
          }}
        />
        <button
          onClick={go} disabled={loading}
          style={{
            height: 36, padding: '0 18px', background: loading ? '#e5e5e5' : '#111',
            border: '1px solid #ddd', borderRadius: '0 6px 6px 0',
            fontFamily: FONT, fontSize: 11, fontWeight: 600,
            color: loading ? '#999' : 'white', cursor: loading ? 'default' : 'pointer',
          }}
        >
          {loading ? '…' : 'Go'}
        </button>
      </div>
      {error && <div style={{ fontSize: 11, color: '#ef4444', maxWidth: 400, textAlign: 'center' }}>{error}</div>}
      <div style={{ fontSize: 10, color: 'rgba(0,0,0,0.22)', textAlign: 'center', lineHeight: 1.7 }}>
        Public demo — 10 req/min per IP.{' '}
        <a href="https://github.com/Badgerion/hollow" target="_blank" rel="noopener noreferrer" style={{ color: 'rgba(0,0,0,0.35)' }}>
          Deploy your own
        </a>
      </div>
    </div>
  );
}

/* ─── QR Panel ───────────────────────────────────────────────────────────────── */

function QRPanel({ sessionId, onClose }: { sessionId: string | null; onClose: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [copied, setCopied] = useState(false);

  const BASE = 'https://hollow-tan-omega.vercel.app';
  const connectionUrl = sessionId
    ? `${BASE}/?session=${encodeURIComponent(sessionId)}`
    : BASE;

  useEffect(() => {
    if (!canvasRef.current) return;
    import('qrcode').then(QRCode => {
      QRCode.toCanvas(canvasRef.current!, connectionUrl, {
        width: 160, margin: 1,
        color: { dark: '#e2e2e2', light: '#111113' },
      });
    });
  }, [connectionUrl]);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(connectionUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard denied */ }
  }

  return (
    <>
      {/* Backdrop — click outside to close */}
      <div style={{ position: 'fixed', inset: 0, zIndex: 999 }} onClick={onClose} />

      {/* Modal */}
      <div style={{
        position: 'fixed', top: 70, right: 20, width: 320,
        background: '#111113',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 10,
        boxShadow: '0 20px 60px rgba(0,0,0,0.8)',
        padding: 20,
        zIndex: 1000,
        fontFamily: FONT,
      }}>
        {/* X */}
        <button
          onClick={onClose}
          style={{ position: 'absolute', top: 10, right: 12, background: 'none', border: 'none', color: 'rgba(255,255,255,0.3)', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: 0 }}
        >×</button>

        {/* QR code */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, marginBottom: 14 }}>
          <canvas ref={canvasRef} style={{ borderRadius: 4 }} />
          {!sessionId && (
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', textAlign: 'center', lineHeight: 1.5, padding: '0 8px' }}>
              Load a page first to get a session URL
            </div>
          )}
          <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', textAlign: 'center' }}>
            Scan to connect any AI
          </div>
        </div>

        {/* Divider */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.06)' }} />
          <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.25)' }}>or</span>
          <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.06)' }} />
        </div>

        {/* Session URL */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.3)', letterSpacing: '0.15em' }}>SESSION URL</div>
          <div
            title={connectionUrl}
            style={{
              background: '#0a0a0b',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 6,
              padding: '8px 12px',
              fontSize: 10,
              color: '#00d4a4',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >{connectionUrl}</div>
          <button
            onClick={handleCopy}
            style={{
              width: '100%', padding: '7px 0',
              background: copied ? 'rgba(0,212,164,0.12)' : 'rgba(255,255,255,0.06)',
              border: `1px solid ${copied ? 'rgba(0,212,164,0.3)' : 'rgba(255,255,255,0.1)'}`,
              borderRadius: 6, fontSize: 11, cursor: 'pointer',
              color: copied ? '#00d4a4' : 'rgba(255,255,255,0.6)',
              fontFamily: FONT,
              transition: 'background 0.15s, color 0.15s, border-color 0.15s',
            }}
          >{copied ? 'Copied ✓' : 'Copy URL'}</button>
        </div>

        {/* Open connection page */}
        <a
          href={connectionUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: 'block', textAlign: 'center',
            marginTop: 10, padding: '8px 0',
            background: '#00d4a4', borderRadius: 6,
            fontSize: 11, fontWeight: 600,
            color: '#000', textDecoration: 'none',
            fontFamily: FONT, letterSpacing: '0.02em',
          }}
        >Open connection page ↗</a>

        {/* Hint */}
        <div style={{ marginTop: 10, fontSize: 9, color: 'rgba(255,255,255,0.25)', textAlign: 'center', lineHeight: 1.7 }}>
          Paste the session URL or scan the QR<br />into Claude, GPT, or Gemini
        </div>
      </div>
    </>
  );
}

/* ─── Log row ────────────────────────────────────────────────────────────────── */

function LogRow({ entry, expanded, onToggle }: { entry: LogEntry; expanded: boolean; onToggle: () => void }) {
  const hasGdg = !!entry.gdgMap;
  const c = TAG_STYLE[entry.tag];
  return (
    <div style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
      <div
        onClick={hasGdg ? onToggle : undefined}
        style={{ display: 'flex', alignItems: 'flex-start', gap: 6, padding: '3px 12px', cursor: hasGdg ? 'pointer' : 'default', fontFamily: FONT, fontSize: 10, lineHeight: 1.6 }}
      >
        <span style={{ color: 'rgba(255,255,255,0.25)', flexShrink: 0, paddingTop: 1, fontSize: 9 }}>{fmtTime(entry.timestamp)}</span>
        <span style={{ display: 'inline-block', padding: '0 5px', borderRadius: 3, fontSize: 9, fontWeight: 700, letterSpacing: '0.06em', lineHeight: '15px', color: c.text, background: c.bg, flexShrink: 0, minWidth: 30, textAlign: 'center' }}>{entry.tag}</span>
        <span style={{ color: 'rgba(255,255,255,0.72)', flex: 1, wordBreak: 'break-word' }}>{entry.message}</span>
        {hasGdg && <span style={{ color: '#00d4a4', flexShrink: 0, paddingTop: 1, fontSize: 9 }}>{expanded ? '▼' : '▶'} MAP</span>}
        {entry.confidence !== undefined && <span style={{ color: confColor(entry.confidence), flexShrink: 0, paddingTop: 1, fontSize: 9, fontWeight: 700 }}>{entry.confidence.toFixed(2)}</span>}
      </div>
      {hasGdg && expanded && (
        <pre style={{ margin: '0 12px 6px', padding: '8px 12px', background: 'rgba(0,212,164,0.05)', border: '1px solid rgba(0,212,164,0.15)', borderRadius: 4, fontSize: 9, lineHeight: 1.6, color: '#00d4a4', overflowX: 'auto', whiteSpace: 'pre', fontFamily: FONT }}>
          {entry.gdgMap}
        </pre>
      )}
    </div>
  );
}

/* ─── Main component ─────────────────────────────────────────────────────────── */

export function MatrixMirror({ sessionId }: { sessionId: string | null }) {

  /* Session state */
  const [status, setStatus] = useState<ConnStatus>('disconnected');
  const [currentUrl, setCurrentUrl] = useState('—');
  const [confidence, setConfidence] = useState<number | null>(null);
  const [tier, setTier] = useState<Tier | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [domHtml, setDomHtml] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [tabs, setTabs] = useState<SessionTabEntry[]>([]);
  const [intervention, setIntervention] = useState('');
  const [staged, setStaged] = useState<string | null>(null);

  /* UI state */
  const [showLog, setShowLog] = useState(false);
  const [showQR, setShowQR] = useState(false);
  const [navInput, setNavInput] = useState('');
  const [navLoading, setNavLoading] = useState(false);
  const [hovTl, setHovTl] = useState(false);
  const [winPos, setWinPos] = useState({ x: 0, y: 0 });

  const logRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const dragRef = useRef<{ sx: number; sy: number; ix: number; iy: number } | null>(null);

  /* Drag */
  function onTitleDown(e: React.MouseEvent) {
    if ((e.target as HTMLElement).closest('button')) return;
    dragRef.current = { sx: e.clientX, sy: e.clientY, ix: winPos.x, iy: winPos.y };
    const move = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      setWinPos({ x: dragRef.current.ix + ev.clientX - dragRef.current.sx, y: dragRef.current.iy + ev.clientY - dragRef.current.sy });
    };
    const up = () => { dragRef.current = null; window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  const addEntry = useCallback((entry: Omit<LogEntry, 'id'>) => {
    setLog(prev => {
      if (entry.dedupKey && prev.some(e => e.dedupKey === entry.dedupKey)) return prev;
      return [...prev, { id: uid(), ...entry }];
    });
  }, []);

  /* Auto-scroll log */
  useEffect(() => { const el = logRef.current; if (el) el.scrollTop = el.scrollHeight; }, [log]);

  /* Populate URL bar when session URL becomes known */
  useEffect(() => {
    const td = tabs.find(t => t.sessionId === sessionId);
    const url = td?.url ?? (currentUrl !== '—' ? currentUrl : null);
    if (url && !navInput) setNavInput(url);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs, sessionId, currentUrl]);

  /* Highlight iframe element */
  useEffect(() => {
    if (activeId === null || !iframeRef.current) return;
    const t = setTimeout(() => { iframeRef.current?.contentWindow?.postMessage({ type: 'hollow:highlight', id: activeId }, '*'); }, 300);
    return () => clearTimeout(t);
  }, [activeId]);

  /* Tab sync */
  useEffect(() => {
    let alive = true;
    const fetch_ = async () => {
      try {
        const res = await fetch('/api/sessions');
        if (!res.ok || !alive) return;
        const d = await res.json() as { sessions: SessionTabEntry[] };
        if (alive) setTabs(d.sessions ?? []);
      } catch { /* silent */ }
    };
    fetch_();
    const t = setInterval(fetch_, 5000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  /* Ghost DOM click interception */
  useEffect(() => {
    if (!sessionId) return;
    const handler = async (e: MessageEvent) => {
      if (e.data?.type !== 'hollow-click') return;
      const { hollowId, href, text } = e.data as { hollowId: number | null; href: string | null; text: string };
      if (hollowId) {
        addEntry({ tag: 'ACT', message: `Ghost click → #${hollowId}${text ? ` "${text}"` : ''}`, timestamp: new Date().toISOString() });
        await callAct(sessionId, { type: 'click', elementId: hollowId });
      } else if (href) {
        const abs = href.startsWith('http') ? href : currentUrl !== '—' ? new URL(href, currentUrl).toString() : href;
        addEntry({ tag: 'SYS', message: `Ghost nav → ${abs}`, timestamp: new Date().toISOString() });
        await callPerceive(abs, sessionId);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [sessionId, currentUrl, addEntry]);

  /* SSE + polling fallback */
  useEffect(() => {
    if (!sessionId) return;
    setStatus('connecting');
    addEntry({ tag: 'SYS', message: `Connecting to ${sessionId}…`, timestamp: new Date().toISOString() });

    let hasData = false;
    let pollInterval: ReturnType<typeof setInterval> | null = null;
    let lastUpdatedAt = 0;
    let sseDropLogged = false;
    let pollingFoundLogged = false;

    const stopPolling = () => { if (pollInterval) { clearInterval(pollInterval); pollInterval = null; } };

    const startPolling = () => {
      if (pollInterval) return;
      setStatus('polling');
      addEntry({ tag: 'SYS', message: 'SSE unavailable — switching to 2s polling.', timestamp: new Date().toISOString() });
      pollInterval = setInterval(async () => {
        try {
          const res = await fetch(`/api/session/${sessionId}`);
          if (!res.ok) return;
          const d = await res.json();
          if (d.updatedAt === lastUpdatedAt) return;
          if (!pollingFoundLogged) { pollingFoundLogged = true; addEntry({ tag: 'SYS', message: 'Session found. Polling active.', timestamp: new Date().toISOString() }); }
          lastUpdatedAt = d.updatedAt;
          if (d.html) setDomHtml(d.html);
          if (d.url) setCurrentUrl(d.url);
          if (d.confidence != null) setConfidence(d.confidence);
          if (d.tier) setTier(d.tier as Tier);
          if (d.gdgMap) {
            addEntry({
              tag: 'GDG',
              message: `Map updated (step ${d.stepCount}). ${d.tokenEstimate ?? '?'} tokens. Confidence: ${d.confidence?.toFixed(2) ?? '?'}. Tier: ${d.tier ?? '?'}.`,
              timestamp: new Date().toISOString(),
              gdgMap: d.gdgMap, confidence: d.confidence, tier: d.tier as Tier,
              dedupKey: `gdg:${(d.gdgMap as string).slice(0, 64)}`,
            });
          }
        } catch { /* retry */ }
      }, 2000);
    };

    const watchdog = setTimeout(startPolling, 10_000);
    const sse = new EventSource(`/api/stream/${sessionId}`);

    sse.addEventListener('connect', (e: MessageEvent) => {
      const d = JSON.parse(e.data); setStatus('connected');
      addEntry({ tag: 'SYS', message: d.message ?? 'Stream connected.', timestamp: new Date().toISOString() });
    });
    sse.addEventListener('log_entry', (e: MessageEvent) => {
      const d = JSON.parse(e.data);
      if (d.tag === 'GDG') return;
      if (typeof d.message === 'string' && /session not found/i.test(d.message)) return;
      addEntry({ tag: d.tag as LogTag, message: d.message, timestamp: d.timestamp ?? new Date().toISOString() });
      if (d.tag === 'ACT' && d.elementId !== undefined) setActiveId(d.elementId as number);
    });
    sse.addEventListener('gdg_map', (e: MessageEvent) => {
      clearTimeout(watchdog); stopPolling(); hasData = true;
      const d = JSON.parse(e.data);
      if (d.confidence !== undefined) setConfidence(d.confidence);
      if (d.tier) setTier(d.tier as Tier);
      addEntry({
        tag: 'GDG',
        message: `Map generated. ${d.tokenEstimate ?? '?'} tokens. Confidence: ${d.confidence?.toFixed(2) ?? '?'}. Tier: ${d.tier ?? '?'}.`,
        timestamp: d.timestamp ?? new Date().toISOString(),
        gdgMap: d.map, confidence: d.confidence, tier: d.tier as Tier,
        dedupKey: `gdg:${(d.map ?? '').slice(0, 64)}`,
      });
    });
    sse.addEventListener('confidence', (e: MessageEvent) => {
      const d = JSON.parse(e.data); setConfidence(d.score); setTier(d.tier as Tier);
    });
    sse.addEventListener('dom_delta', (e: MessageEvent) => {
      clearTimeout(watchdog); stopPolling(); hasData = true; setStatus('connected');
      const d = JSON.parse(e.data); setDomHtml(d.html); if (d.url) setCurrentUrl(d.url);
    });
    sse.addEventListener('tier', (e: MessageEvent) => { const d = JSON.parse(e.data); setTier(d.tier as Tier); });
    sse.addEventListener('js_errors', (e: MessageEvent) => {
      const d = JSON.parse(e.data);
      if (Array.isArray(d.errors)) {
        for (const err of d.errors) addEntry({ tag: 'WARN', message: `${err.type}: ${err.message}`, timestamp: new Date().toISOString() });
      }
    });
    sse.addEventListener('reconnect', () => {
      if (!pollInterval) setStatus('connecting');
      addEntry({ tag: 'SYS', message: 'Stream cycling — reconnecting…', timestamp: new Date().toISOString() });
    });
    sse.onerror = () => {
      if (!hasData) { clearTimeout(watchdog); startPolling(); }
      else {
        setStatus('error');
        if (!sseDropLogged) {
          sseDropLogged = true;
          addEntry({ tag: 'SYS', message: 'SSE stream ended. Polling active.', timestamp: new Date().toISOString() });
        }
      }
    };
    return () => { clearTimeout(watchdog); stopPolling(); sse.close(); };
  }, [sessionId, addEntry]);

  /* Handlers */
  async function handleNavigate() {
    const v = navInput.trim(); if (!v || navLoading || !sessionId) return;
    setNavLoading(true);
    addEntry({ tag: 'SYS', message: `Navigating to: ${v}`, timestamp: new Date().toISOString() });
    try { await callPerceive(v, sessionId); setNavInput(''); }
    catch (e) { addEntry({ tag: 'ERR', message: `Navigate failed: ${e instanceof Error ? e.message : String(e)}`, timestamp: new Date().toISOString() }); }
    finally { setNavLoading(false); }
  }

  async function handleRefresh() {
    if (!sessionId || currentUrl === '—') return;
    addEntry({ tag: 'SYS', message: `Refreshing: ${currentUrl}`, timestamp: new Date().toISOString() });
    await callPerceive(currentUrl, sessionId);
  }

  async function handleNewTab() {
    try {
      const r = await callPerceive('https://www.startpage.com');
      window.location.href = `/mirror?session=${encodeURIComponent(r.sessionId)}`;
    } catch { /* silent */ }
  }

  function submitIntervention() {
    const text = intervention.trim(); if (!text || !sessionId) return;
    setStaged(text); setIntervention('');
    addEntry({ tag: 'SYS', message: `Intervention staged: "${text}"`, timestamp: new Date().toISOString() });
    fetch('/api/stage-intervention', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId, text }) }).catch(() => {});
  }

  function toggleExpand(id: string) {
    setExpandedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  /* Derived */
  const isLive = status === 'connected' || status === 'polling';
  const ts = tier ? (TIER_STYLE[tier] ?? TIER_STYLE.partial) : null;
  const tabData = tabs.find(t => t.sessionId === sessionId);
  const tabUrl = tabData?.url ?? currentUrl;
  const shortTabUrl = tabUrl && tabUrl !== '—'
    ? tabUrl.replace(/^https?:\/\/(www\.)?/, '').slice(0, 28)
    : sessionId ? `${sessionId.slice(5, 13)}…` : 'Hollow';
  const iframeContent = domHtml ? injectHollowScript(domHtml, currentUrl !== '—' ? currentUrl : undefined) : null;
  const displayPlaceholder = currentUrl !== '—' ? currentUrl : 'https://';

  /* Pill style */
  const pill: React.CSSProperties = {
    fontFamily: FONT, fontSize: 10, fontWeight: 700, letterSpacing: '0.08em',
    textTransform: 'uppercase', padding: '2px 8px', borderRadius: 4, flexShrink: 0,
  };

  /* Button base */
  const tbBtn: React.CSSProperties = {
    height: 20, padding: '0 8px',
    background: 'rgba(255,255,255,0.06)',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 10, fontFamily: FONT, fontSize: 10,
    color: 'rgba(255,255,255,0.6)', cursor: 'pointer',
  };

  return (
    <>
      <style>{`
        *, *::before, *::after { box-sizing: border-box; }
        body { margin: 0; overflow: hidden; background: #0d0d1a; }
        ::-webkit-scrollbar { width: 4px; height: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 2px; }
        input, button, textarea { font-family: inherit; }
        .hov-tab:hover { background: rgba(255,255,255,0.06) !important; }
        .hov-btn:hover { background: rgba(255,255,255,0.14) !important; }
        .hov-new-tab:hover { color: rgba(255,255,255,0.8) !important; }
        .tl-sym { opacity: 0; transition: opacity 0.1s; }
        .tl-group:hover .tl-sym { opacity: 1; }
        @keyframes pulse-teal {
          0%, 100% { box-shadow: 0 0 0 0 rgba(0,212,164,0.4); }
          50%       { box-shadow: 0 0 0 8px rgba(0,212,164,0); }
        }
        .connect-pulse { animation: pulse-teal 2s ease 3; }
        .connect-btn:hover { background: #00b894 !important; transform: scale(1.02); }
      `}</style>

      <Wallpaper />
      <MenuBar />

      {/* Desktop layer */}
      <div style={{ position: 'fixed', inset: 0, paddingTop: 24, paddingBottom: 92, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10, pointerEvents: 'none' }}>

        {/* Window */}
        <div style={{
          pointerEvents: 'all',
          width: 'calc(100vw - 220px)', maxWidth: 1160,
          height: 'calc(100vh - 130px)',
          background: '#0e0e10',
          borderRadius: 10,
          boxShadow: '0 40px 120px rgba(0,0,0,0.8), 0 0 0 1px rgba(255,255,255,0.08)',
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
          transform: `translate(${winPos.x}px, ${winPos.y}px)`,
          position: 'relative',
        }}>

          {/* ── Title bar ─────────────────────────────────────────────── */}
          <div
            onMouseDown={onTitleDown}
            style={{
              height: 38, flexShrink: 0,
              background: '#1c1c1e',
              borderRadius: '10px 10px 0 0',
              borderBottom: '1px solid rgba(255,255,255,0.06)',
              display: 'flex', alignItems: 'center',
              padding: '0 12px', cursor: 'grab', userSelect: 'none',
              position: 'relative',
            }}
          >
            {/* Traffic lights */}
            <div
              className="tl-group"
              onMouseEnter={() => setHovTl(true)}
              onMouseLeave={() => setHovTl(false)}
              style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}
            >
              {[{ c: '#ff5f56', s: '×' }, { c: '#ffbd2e', s: '−' }, { c: '#27c93f', s: '+' }].map(({ c, s }) => (
                <div key={c} style={{ width: 12, height: 12, borderRadius: '50%', background: c, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                  <span className="tl-sym" style={{ fontSize: 8, color: 'rgba(0,0,0,0.55)', lineHeight: 1, opacity: hovTl ? 1 : 0 }}>{s}</span>
                </div>
              ))}
            </div>

            {/* Center title */}
            <div style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <HollowMark size={14} opacity={0.6} />
              <span style={{ fontFamily: FONT, fontSize: 12, color: 'rgba(255,255,255,0.6)' }}>Hollow</span>
            </div>

            {/* Right controls */}
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
              <button
                className="connect-btn connect-pulse"
                onClick={() => setShowQR(q => !q)}
                style={{
                  height: 24, padding: '0 14px',
                  background: '#00d4a4',
                  border: 'none', borderRadius: 6,
                  fontFamily: FONT, fontSize: 11, fontWeight: 600,
                  letterSpacing: '0.05em', color: '#000',
                  cursor: 'pointer',
                  transition: 'background 0.15s, transform 0.15s',
                }}
              >⊞ CONNECT</button>
              <button
                onClick={() => setShowLog(l => !l)}
                style={{ ...tbBtn, background: showLog ? 'rgba(255,255,255,0.18)' : tbBtn.background }}
              >
                ≡ LOG
              </button>
            </div>
          </div>

          {/* ── Tab bar ───────────────────────────────────────────────── */}
          <div style={{ height: 36, flexShrink: 0, background: '#161618', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', padding: '0 8px', gap: 2, overflow: 'hidden' }}>
            {/* Active tab */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, height: 28, padding: '0 10px', background: '#0e0e10', borderRadius: '6px 6px 0 0', border: '1px solid rgba(255,255,255,0.08)', borderBottom: '1px solid #0e0e10', flexShrink: 0, maxWidth: 200 }}>
              <HollowMark size={10} opacity={0.7} />
              <span style={{ fontFamily: FONT, fontSize: 11, color: 'rgba(255,255,255,0.8)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 140 }}>
                {shortTabUrl}
              </span>
            </div>

            {/* Other sessions */}
            {tabs.filter(t => t.sessionId !== sessionId).slice(0, 4).map(tab => (
              <div
                key={tab.sessionId}
                className="hov-tab"
                onClick={() => { window.location.href = `/mirror?session=${encodeURIComponent(tab.sessionId)}`; }}
                style={{ display: 'flex', alignItems: 'center', gap: 6, height: 28, padding: '0 10px', background: '#1a1a1c', borderRadius: '6px 6px 0 0', border: '1px solid rgba(255,255,255,0.06)', flexShrink: 0, maxWidth: 160, cursor: 'pointer' }}
              >
                <HollowMark size={10} opacity={0.35} />
                <span style={{ fontFamily: FONT, fontSize: 11, color: 'rgba(255,255,255,0.45)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 110 }}>
                  {(tab.url ?? '').replace(/^https?:\/\/(www\.)?/, '').slice(0, 22) || 'Session'}
                </span>
              </div>
            ))}

            {/* New tab */}
            <button
              onClick={handleNewTab}
              className="hov-new-tab"
              style={{ width: 28, height: 28, flexShrink: 0, background: 'transparent', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, color: 'rgba(255,255,255,0.35)', fontSize: 18, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1, padding: 0 }}
            >
              +
            </button>
          </div>

          {/* ── Nav bar ───────────────────────────────────────────────── */}
          <div style={{ height: 40, flexShrink: 0, background: '#161618', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', padding: '0 12px', gap: 8 }}>
            <button disabled style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.2)', fontSize: 16, cursor: 'default', padding: '0 2px', lineHeight: 1 }}>←</button>
            <button disabled style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.2)', fontSize: 16, cursor: 'default', padding: '0 2px', lineHeight: 1 }}>→</button>
            <button
              onClick={handleRefresh}
              style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.6)', fontSize: 17, cursor: 'pointer', padding: '0 2px', lineHeight: 1, transition: 'transform 0.35s ease' }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.transform = 'rotate(360deg)'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.transform = 'rotate(0deg)'; }}
            >↺</button>

            {/* URL bar */}
            <div style={{ flex: 1, height: 26, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, display: 'flex', alignItems: 'center', padding: '0 8px', gap: 5 }}>
              {confidence !== null && (
                <span style={{ fontSize: 11, flexShrink: 0, lineHeight: 1 }}>
                  {confidence >= 0.8 ? '🔒' : '🔓'}
                </span>
              )}
              <input
                type="text"
                value={navInput}
                onChange={e => setNavInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleNavigate()}
                onFocus={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.3)'; if (!navInput) setNavInput(displayPlaceholder); }}
                onBlur={e => { e.currentTarget.style.borderColor = 'transparent'; }}
                placeholder={displayPlaceholder}
                disabled={navLoading}
                style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', fontFamily: FONT, fontSize: 11, color: 'rgba(255,255,255,0.9)' }}
              />
            </div>

            {confidence !== null && (
              <span style={{ fontFamily: FONT, fontSize: 11, fontWeight: 700, color: confColor(confidence), flexShrink: 0 }}>
                {confidence.toFixed(2)}
              </span>
            )}
            {tier && ts && (
              <span style={{ ...pill, color: ts.text, background: ts.bg, border: `1px solid ${ts.text}33` }}>
                {tier === 'mobile-api' ? 'MOBILE' : tier}
              </span>
            )}
          </div>

          {/* ── Content area ──────────────────────────────────────────── */}
          <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>

            {/* Ghost DOM panel */}
            <div style={{ width: showLog ? '65%' : '100%', display: 'flex', flexDirection: 'column', transition: 'width 0.25s ease', minWidth: 0 }}>
              <div style={{ height: 28, flexShrink: 0, background: '#111113', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', padding: '0 12px' }}>
                <span style={{ fontFamily: FONT, fontSize: 10, letterSpacing: '0.1em', color: 'rgba(255,255,255,0.3)', flex: 1 }}>GHOST DOM</span>
                <span style={{ fontFamily: FONT, fontSize: 10, color: isLive ? '#27c93f' : 'rgba(255,255,255,0.2)', display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ width: 5, height: 5, borderRadius: '50%', background: isLive ? '#27c93f' : 'rgba(255,255,255,0.15)', display: 'inline-block' }} />
                  {isLive ? 'LIVE' : 'IDLE'}
                </span>
              </div>
              <div style={{ flex: 1, overflow: 'hidden', position: 'relative', display: 'flex', flexDirection: 'column' }}>
                {!sessionId ? (
                  <StartPanel />
                ) : iframeContent ? (
                  <iframe
                    ref={iframeRef}
                    srcDoc={iframeContent}
                    sandbox="allow-scripts allow-same-origin"
                    style={{ width: '100%', height: '100%', border: 'none', background: 'white', display: 'block' }}
                  />
                ) : (
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: '#0e0e10', fontFamily: FONT }}>
                    <HollowMark size={32} opacity={0.12} />
                    <div style={{ marginTop: 14, fontSize: 11, color: 'rgba(255,255,255,0.18)' }}>
                      {status === 'connecting' ? 'Connecting…' : status === 'polling' ? 'Polling for session…' : 'Waiting for Ghost DOM…'}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Agent log panel */}
            <div style={{ width: showLog ? '35%' : 0, flexShrink: 0, overflow: 'hidden', transition: 'width 0.25s ease', borderLeft: '1px solid rgba(255,255,255,0.06)', display: 'flex', flexDirection: 'column' }}>
              <div style={{ height: 28, flexShrink: 0, background: '#111113', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', padding: '0 12px' }}>
                <span style={{ fontFamily: FONT, fontSize: 10, letterSpacing: '0.1em', color: 'rgba(255,255,255,0.3)', flex: 1 }}>AGENT LOG</span>
                <span style={{ fontFamily: FONT, fontSize: 10, color: 'rgba(255,255,255,0.2)' }}>{log.length} entries</span>
              </div>
              <div ref={logRef} style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
                {log.map(entry => (
                  <LogRow key={entry.id} entry={entry} expanded={expandedIds.has(entry.id)} onToggle={() => toggleExpand(entry.id)} />
                ))}
                {log.length === 0 && (
                  <div style={{ padding: 20, fontFamily: FONT, fontSize: 10, color: 'rgba(255,255,255,0.14)', textAlign: 'center' }}>No entries yet</div>
                )}
              </div>
            </div>
          </div>

          {/* ── Bottom bar ────────────────────────────────────────────── */}
          <div style={{ height: 36, flexShrink: 0, background: '#111113', borderTop: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', padding: '0 12px', gap: 8 }}>
            <span style={{ fontFamily: FONT, fontSize: 10, letterSpacing: '0.1em', color: 'rgba(255,255,255,0.3)', flexShrink: 0 }}>INTERVENTION ›</span>
            <input
              type="text"
              value={intervention}
              onChange={e => setIntervention(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && submitIntervention()}
              placeholder={staged ? `Staged: "${staged}"` : 'Type instruction for next agent step…'}
              style={{
                flex: 1, height: 24,
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: 4, padding: '0 8px',
                fontFamily: FONT, fontSize: 10,
                color: 'rgba(255,255,255,0.8)', outline: 'none',
              }}
              onFocus={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.2)'; }}
              onBlur={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)'; }}
            />
            <button
              onClick={submitIntervention}
              className="hov-btn"
              style={{ height: 24, padding: '0 12px', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 4, fontFamily: FONT, fontSize: 10, color: 'rgba(255,255,255,0.6)', cursor: 'pointer', flexShrink: 0 }}
            >
              STAGE
            </button>
          </div>

        </div>{/* /window */}
      </div>

      <Dock active={!!sessionId} />

      {/* QR modal — rendered at root so window overflow:hidden can't clip it */}
      {showQR && <QRPanel sessionId={sessionId} onClose={() => setShowQR(false)} />}
    </>
  );
}
