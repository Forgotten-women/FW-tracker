'use client';

import React from 'react';
import type { PresenceStatus } from '@/lib/types';

export const STATUS_META: Record<
  PresenceStatus,
  { label: string; tone: 'ok' | 'warn' | 'muted' | 'dim' | 'accent' | 'danger' }
> = {
  IN_OFFICE: { label: 'In Office', tone: 'ok' },
  GRACE_PERIOD: { label: 'Grace Period', tone: 'warn' },
  AWAY: { label: 'Away', tone: 'muted' },
  NOT_CHECKED_IN: { label: 'Not Arrived', tone: 'dim' },
  CLOSED: { label: 'Closed', tone: 'dim' },
};

const TONE_STYLES: Record<string, string> = {
  ok: 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shadow-sm shadow-emerald-500/5',
  warn: 'bg-amber-500/10 text-amber-400 border border-amber-500/20 shadow-sm shadow-amber-500/5',
  danger: 'bg-rose-500/10 text-rose-400 border border-rose-500/20 shadow-sm shadow-rose-500/5',
  accent: 'bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 shadow-sm shadow-indigo-500/5',
  info: 'bg-sky-500/10 text-sky-400 border border-sky-500/20 shadow-sm shadow-sky-500/5',
  muted: 'bg-slate-800/60 text-slate-300 border border-slate-700/50',
  dim: 'bg-slate-900/40 text-slate-500 border border-slate-800/40',
};

const TONE_DOTS: Record<string, string> = {
  ok: 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)] animate-pulse',
  warn: 'bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.6)]',
  danger: 'bg-rose-400 shadow-[0_0_8px_rgba(251,113,133,0.6)]',
  accent: 'bg-indigo-400 shadow-[0_0_8px_rgba(129,140,248,0.6)]',
  info: 'bg-sky-400 shadow-[0_0_8px_rgba(56,189,248,0.6)]',
  muted: 'bg-slate-400',
  dim: 'bg-slate-600',
};

export function Badge({
  tone = 'muted',
  dot = false,
  size = 'md',
  className = '',
  children,
}: {
  tone?: string;
  dot?: boolean;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  children: React.ReactNode;
}) {
  const sizeClasses = {
    sm: 'px-2 py-0.5 text-[10px]',
    md: 'px-2.5 py-1 text-xs',
    lg: 'px-3 py-1.5 text-xs',
  }[size];

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full font-medium whitespace-nowrap backdrop-blur-xs transition-colors ${
        TONE_STYLES[tone] ?? TONE_STYLES.muted
      } ${sizeClasses} ${className}`}
    >
      {dot && (
        <span
          className={`h-1.5 w-1.5 rounded-full ${
            TONE_DOTS[tone] ?? TONE_DOTS.muted
          }`}
        />
      )}
      {children}
    </span>
  );
}

export function Panel({
  title,
  subtitle,
  icon,
  note,
  actions,
  className = '',
  children,
}: {
  title: React.ReactNode;
  subtitle?: string;
  icon?: React.ReactNode;
  note?: string;
  actions?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className={`glass-panel rounded-2xl p-6 transition-all duration-300 min-w-0 ${className}`}
    >
      <header className="mb-5 flex flex-wrap items-center justify-between gap-4 border-b border-white/5 pb-4">
        <div className="flex items-center gap-3">
          {icon && (
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-800/80 border border-white/8 text-indigo-400 shadow-inner">
              {icon}
            </div>
          )}
          <div>
            <h2 className="text-base font-bold tracking-tight text-white flex items-center gap-2">
              {title}
            </h2>
            {subtitle && (
              <p className="mt-0.5 text-xs text-slate-400">{subtitle}</p>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {note && (
            <span className="text-xs text-slate-400 bg-slate-800/40 px-2.5 py-1 rounded-lg border border-white/5">
              {note}
            </span>
          )}
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      </header>
      {children}
    </section>
  );
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  className = '',
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'accent' | 'success';
  size?: 'sm' | 'md' | 'lg';
  icon?: React.ReactNode;
}) {
  const base =
    'relative inline-flex items-center justify-center gap-2 font-semibold transition-all duration-150 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none cursor-pointer';

  const sizeClasses = {
    sm: 'rounded-lg px-2.5 py-1.5 text-xs',
    md: 'rounded-xl px-3.5 py-2 text-xs',
    lg: 'rounded-xl px-5 py-2.5 text-sm',
  }[size];

  const variants = {
    primary:
      'bg-emerald-500 hover:bg-emerald-400 text-slate-950 shadow-lg shadow-emerald-500/20 font-bold border border-emerald-400/30',
    accent:
      'bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-600/25 font-bold border border-indigo-500/40',
    success:
      'bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-600/20 border border-emerald-500/30',
    secondary:
      'bg-slate-800/90 hover:bg-slate-700/90 text-slate-200 border border-white/10 hover:border-white/20 shadow-sm hover:text-white',
    ghost:
      'bg-transparent hover:bg-white/5 text-slate-400 hover:text-slate-100 border border-transparent hover:border-white/5',
    danger:
      'bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/30 hover:border-rose-500/50 shadow-sm shadow-rose-500/5',
  }[variant];

  return (
    <button className={`${base} ${sizeClasses} ${variants} ${className}`} {...props}>
      {icon && <span className="shrink-0">{icon}</span>}
      {children}
    </button>
  );
}

export function Input({
  icon,
  className = '',
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { icon?: React.ReactNode }) {
  return (
    <div className="relative flex items-center min-w-0 w-full">
      {icon && (
        <span className="absolute left-3.5 text-slate-500 pointer-events-none">
          {icon}
        </span>
      )}
      <input
        {...props}
        className={`w-full rounded-xl border border-white/10 bg-slate-900/80 px-3.5 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-indigo-500/70 focus:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 transition-all ${
          icon ? 'pl-10' : ''
        } ${className}`}
      />
    </div>
  );
}

export function Empty({
  title = 'No records found',
  description,
  icon,
  action,
  children,
}: {
  title?: string;
  description?: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-white/8 bg-slate-900/20 py-12 px-4 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-800/60 border border-white/5 text-slate-400 mb-3 shadow-inner">
        {icon ?? (
          <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
          </svg>
        )}
      </div>
      <h3 className="text-sm font-semibold text-slate-300">{title}</h3>
      {description && (
        <p className="mt-1 max-w-sm text-xs text-slate-500">{description}</p>
      )}
      {children}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
