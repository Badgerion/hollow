import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Hollow — Matrix Mirror',
  description: 'Observability UI for the Hollow browser engine',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600&display=swap"
        />
      </head>
      <body style={{ margin: 0, background: '#0a0a0a', color: '#e5e5e5', fontFamily: 'monospace' }}>
        {children}
      </body>
    </html>
  );
}
