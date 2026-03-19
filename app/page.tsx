/**
 * Matrix Mirror — placeholder UI.
 *
 * Full implementation comes after the core pipeline is verified.
 * The API is live at /api/perceive, /api/act, /api/stream/:sessionId.
 */

export default function Home() {
  return (
    <main style={{ padding: '48px', maxWidth: '800px', margin: '0 auto' }}>
      <h1 style={{ fontSize: '24px', fontWeight: 700, marginBottom: '8px' }}>
        Hollow
      </h1>
      <p style={{ color: '#888', marginBottom: '32px' }}>
        Matrix Mirror — coming soon. Core pipeline is live.
      </p>

      <section style={{ marginBottom: '32px' }}>
        <h2 style={{ fontSize: '14px', color: '#666', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '12px' }}>
          API Endpoints
        </h2>
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {[
            ['POST', '/api/perceive', '{ url, sessionId? }'],
            ['POST', '/api/act', '{ sessionId, action, intervention? }'],
            ['GET', '/api/stream/:sessionId', 'SSE — Matrix Mirror stream'],
            ['DELETE', '/api/session/:sessionId', 'Clear session from KV'],
          ].map(([method, path, desc]) => (
            <li key={path} style={{
              display: 'grid',
              gridTemplateColumns: '60px 240px 1fr',
              gap: '12px',
              padding: '8px 0',
              borderBottom: '1px solid #1a1a1a',
              fontSize: '13px',
            }}>
              <span style={{ color: method === 'POST' ? '#4ade80' : method === 'GET' ? '#60a5fa' : '#f87171' }}>
                {method}
              </span>
              <span style={{ color: '#e5e5e5' }}>{path}</span>
              <span style={{ color: '#666' }}>{desc}</span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 style={{ fontSize: '14px', color: '#666', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '12px' }}>
          Quick test
        </h2>
        <pre style={{
          background: '#111',
          border: '1px solid #222',
          borderRadius: '6px',
          padding: '16px',
          fontSize: '12px',
          overflowX: 'auto',
          color: '#a3e635',
        }}>
{`curl -X POST http://localhost:3000/api/perceive \\
  -H "Content-Type: application/json" \\
  -d '{"url":"https://example.com"}'`}
        </pre>
      </section>
    </main>
  );
}
