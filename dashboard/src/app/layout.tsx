import type { Metadata } from 'next';
import { JetBrains_Mono, Plus_Jakarta_Sans } from 'next/font/google';
import './globals.css';

const jakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  variable: '--font-jakarta',
  display: 'swap',
});

const jetbrains = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Office Tracker',
  description: 'Live office presence and attendance',
};

// Runs synchronously while <head> is parsed, before first paint, so a saved
// light theme never flashes dark (see Next's "preventing flash before
// hydration" guide). ThemeSwitcher keeps the same keys in sync afterwards.
// Also follows live OS changes, so screens without the switcher (the sign-in gate) flip too.
const themeScript = `(function(){try{var d=document.documentElement;var q=matchMedia('(prefers-color-scheme: light)');var mode=function(){try{return localStorage.getItem('ot-theme')||'system'}catch(e){return 'system'}};var set=function(){var m=mode();d.setAttribute('data-theme',m==='system'?(q.matches?'light':'dark'):m)};set();q.addEventListener('change',function(){if(mode()==='system')set()});var a=localStorage.getItem('ot-accent');if(a)d.setAttribute('data-accent',a);}catch(e){}})()`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      data-theme="dark"
      className={`${jakarta.variable} ${jetbrains.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* Explicit, so the page cannot be sniffed as Latin-1 and render
            UTF-8 punctuation as mojibake. */}
        <meta charSet="utf-8" />
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-screen font-sans antialiased">{children}</body>
    </html>
  );
}
