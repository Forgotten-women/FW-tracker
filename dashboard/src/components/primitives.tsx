'use client';

import type { PresenceStatus } from '@/lib/types';

export const STATUS_META: Record<
  PresenceStatus,
  { label: string; tone: 'ok' | 'warn' | 'muted' | 'dim' }
> = {
  IN_OFFICE: { label: 'In office', tone: 'ok' },
  GRACE_PERIOD: { label: 'Grace period', tone: 'warn' },
  AWAY: { label: 'Away', tone: 'muted' },
  NOT_CHECKED_IN: { label: 'Not arrived', tone: 'dim' },
  CLOSED: { label: 'Closed', tone: 'dim' },
};

const TONE_BADGE: Record<string, string> = {
  ok: 'bg-brand-dim text-brand',
  warn: 'bg-warn-dim text-warn',
  muted: 'bg-white/6 text-muted',
  dim: 'bg-white/6 text-dim',
};

export function Badge({
  tone = 'muted',
  children,
}: {
  tone?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap ${
        TONE_BADGE[tone] ?? TONE_BADGE.muted
      }`}
    >
      {children}
    </span>
  );
}

export function Panel({
  title,
  note,
  actions,
  children,
}: {
  title: React.ReactNode;
  note?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-line bg-surface/70 p-5 min-w-0">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-text">{title}</h2>
        {note ? <span className="text-xs text-muted">{note}</span> : null}
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}

export function Button({
  variant = 'ghost',
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' }) {
  const base =
    'rounded-lg px-3 py-1.5 text-xs font-semibold transition hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed';
  const styles =
    variant === 'primary'
      ? 'bg-brand text-[#05221a]'
      : 'border border-line text-muted hover:text-text';
  return <button className={`${base} ${styles} ${className}`} {...props} />;
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`min-w-0 rounded-lg border border-line bg-raised px-3 py-2 text-sm text-text outline-none placeholder:text-dim focus:border-brand/50 ${
        props.className ?? ''
      }`}
    />
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-6 text-center text-xs text-dim">{children}</p>;
}
