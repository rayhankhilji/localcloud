export const metadata = { title: 'localcloud × Next.js' };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 560, margin: '4rem auto', padding: '0 1rem' }}>{children}</body>
    </html>
  );
}
