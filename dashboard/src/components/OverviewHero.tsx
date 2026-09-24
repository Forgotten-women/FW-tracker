'use client';

import { useId } from 'react';
import type { DashboardSummary } from '@/lib/types';

export type HeroFilter = 'ALL' | 'IN_OFFICE' | 'WORKSTATION' | 'ON_BREAK' | 'LATE' | 'AWAY';

interface Props {
  summary: DashboardSummary;
  total: number;
  inOffice: number;
  laptopsActive: number;
  onBreak: number;
  late: number;
  away: number;
  pendingCorrections: number;
  activeFilter: HeroFilter;
  onFilter: (f: HeroFilter) => void;
  onReviewCorrections?: () => void;
  correctionsOpen?: boolean;
}

function greetingFor(timezone: string): string {
  let hour = new Date().getHours();
  try {
    hour = Number(
      new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: timezone }).format(new Date()),
    );
  } catch {
    // Unknown zone: fall back to the browser's hour.
  }
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

const Icon = {
  office: 'M3 21h18M5 21V7l7-4 7 4v14M9 9h1m-1 4h1m4-4h1m-1 4h1M10 21v-4h4v4',
  laptop: 'M4 6a2 2 0 012-2h12a2 2 0 012 2v9H4V6zm-2 12h20',
  coffee: 'M17 8h1a4 4 0 010 8h-1M3 8h14v9a4 4 0 01-4 4H7a4 4 0 01-4-4V8zm3-6v2m4-2v2m4-2v2',
  clock: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z',
  away: 'M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1',
};

export function OverviewHero({
  summary,
  total,
  inOffice,
  laptopsActive,
  onBreak,
  late,
  away,
  pendingCorrections,
  activeFilter,
  onFilter,
  onReviewCorrections,
  correctionsOpen = false,
}: Props) {
  const gradId = useId();
  const pct = total > 0 ? Math.round((inOffice / total) * 100) : 0;
  const r = 70;
  const c = 2 * Math.PI * r;
  const dash = (c * Math.min(100, pct)) / 100;

  const tiles: {
    filter: HeroFilter;
    label: string;
    value: number;
    hint: string;
    icon: string;
    from: string;
    to: string;
  }[] = [
    { filter: 'IN_OFFICE', label: 'In office', value: inOffice, hint: 'Presence verified', icon: Icon.office, from: '#34d399', to: '#059669' },
    { filter: 'WORKSTATION', label: 'Laptops active', value: laptopsActive, hint: 'Typing / working', icon: Icon.laptop, from: '#22d3ee', to: '#0891b2' },
    { filter: 'ON_BREAK', label: 'On break', value: onBreak, hint: 'Authorised pause', icon: Icon.coffee, from: '#fbbf24', to: '#f59e0b' },
    { filter: 'LATE', label: 'Late / deficit', value: late, hint: 'Policy flagged', icon: Icon.clock, from: '#fb7185', to: '#e11d48' },
    { filter: 'AWAY', label: 'Away / out', value: away, hint: 'Not in office', icon: Icon.away, from: '#94a3b8', to: '#64748b' },
  ];

  return (
    <section aria-label="Today at a glance" className="glass-panel rounded-3xl p-5 sm:p-6">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)] lg:items-center">
        {/* Greeting + presence ring */}
        <div className="flex items-center gap-5">
          <div className="relative h-[164px] w-[164px] shrink-0">
            <svg viewBox="0 0 164 164" className="h-full w-full -rotate-90" aria-hidden="true">
              <defs>
                <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" style={{ stopColor: 'var(--color-indigo-500)' }} />
                  <stop offset="60%" style={{ stopColor: 'var(--accent-end)' }} />
                  <stop offset="100%" style={{ stopColor: 'var(--color-pink-500)' }} />
                </linearGradient>
              </defs>
              <circle cx="82" cy="82" r={r} fill="none" strokeWidth="13" className="stroke-indigo-500/15" />
              <circle
                cx="82"
                cy="82"
                r={r}
                fill="none"
                strokeWidth="13"
                strokeLinecap="round"
                stroke={`url(#${gradId})`}
                strokeDasharray={`${dash} ${c}`}
                className="transition-[stroke-dasharray] duration-700"
              />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-[10px] font-extrabold tracking-wider text-slate-500">IN OFFICE</span>
              <span className="font-mono text-3xl font-bold tracking-tight text-white tnum">
                {inOffice}
                <span className="text-lg text-slate-500">/{total}</span>
              </span>
              <span className="text-xs font-semibold text-slate-400">{pct}% present</span>
            </div>
          </div>

          <div className="min-w-0">
            <p className="text-sm font-medium text-slate-400">{greetingFor(summary.timezone)}</p>
            <h2 className="mt-0.5 text-2xl font-extrabold tracking-tight text-white">Live workforce</h2>
            <p className="mt-1 text-xs text-slate-400">
              {summary.currentDate} · {summary.officeConfig.officeName}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <span className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] font-semibold text-slate-300">
                Avg worked <span className="font-mono text-white tnum">{summary.stats.averageTimeWorkedToday}</span>
              </span>
              <span className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] font-semibold text-slate-300">
                Attended <span className="font-mono text-white tnum">{summary.stats.totalAttendeesToday}</span>
              </span>
            </div>
          </div>
        </div>

        {/* KPI tiles — each filters the workforce grid below */}
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
            {tiles.map((t) => {
              const active = activeFilter === t.filter;
              return (
                <button
                  key={t.filter}
                  type="button"
                  onClick={() => onFilter(active ? 'ALL' : t.filter)}
                  aria-pressed={active}
                  className={`group rounded-2xl border p-3.5 text-left transition-all duration-200 cursor-pointer hover:-translate-y-0.5 ${
                    active
                      ? 'border-indigo-500/60 bg-indigo-500/10 shadow-accent'
                      : 'border-white/10 bg-white/5 hover:bg-white/8'
                  }`}
                >
                  <span
                    className="flex h-9 w-9 items-center justify-center rounded-xl text-on-accent"
                    style={{
                      backgroundImage: `linear-gradient(135deg, ${t.from}, ${t.to})`,
                      boxShadow: `0 8px 18px -6px ${t.to}`,
                    }}
                  >
                    <svg className="h-4.5 w-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d={t.icon} />
                    </svg>
                  </span>
                  <div className="mt-3 font-mono text-2xl font-bold tracking-tight text-white tnum">{t.value}</div>
                  <div className="mt-0.5 text-xs font-bold text-slate-200">{t.label}</div>
                  <div className="text-[11px] text-slate-500">{t.hint}</div>
                </button>
              );
            })}
          </div>

          {pendingCorrections > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
              <div className="flex items-center gap-3">
                <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-amber-500/20 text-amber-400">
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
                  </svg>
                </span>
                <div>
                  <div className="text-sm font-bold text-amber-300">
                    {pendingCorrections} correction request{pendingCorrections > 1 ? 's' : ''} awaiting review
                  </div>
                  <div className="text-xs text-amber-400/80">Manual time adjustments and missed punches from staff.</div>
                </div>
              </div>
              {onReviewCorrections && (
                <button
                  type="button"
                  onClick={onReviewCorrections}
                  aria-expanded={correctionsOpen}
                  className="rounded-xl border border-amber-500/40 bg-amber-500/15 px-3.5 py-1.5 text-xs font-bold text-amber-300 transition hover:bg-amber-500/25 cursor-pointer"
                >
                  {correctionsOpen ? 'Hide requests' : 'Review and decide'}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
