import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Office Tracker',
  description: 'Live office presence and attendance',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <head>
        {/* Explicit, so the page cannot be sniffed as Latin-1 and render
            UTF-8 punctuation as mojibake. */}
        <meta charSet="utf-8" />
      </head>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
