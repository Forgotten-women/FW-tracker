'use client';

// A Mon-Sun month grid of day cells, coloured by status and marked with a
// glyph so the status never rests on colour alone. Keyboard: a roving tab
// stop moves with the arrow keys (Home/End = start/end of the week,
// PageUp/PageDown = previous/next month); Enter or Space opens the day.

import { useRef, useState, type KeyboardEvent } from 'react';
import type { HistoryDaySummary } from '@/lib/types';
import {
  LEGEND_ORDER,
  WEEK_HEADERS,
  addDays,
  dayAriaLabel,
  fmtCompact,
  longDate,
  monthBounds,
  monthLabel,
  monthOf,
  mondayIndex,
  statusMeta,
} from './historyMeta';

const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

interface MonthCalendarProps {
  month: string;
  days: HistoryDaySummary[];
  today: string;
  selected: string | null;
  onSelect: (dateKey: string) => void;
  /** PageUp / PageDown. Omitted steps are disabled at the ends of the range. */
  onMonthStep?: (delta: -1 | 1) => void;
}

export function MonthCalendar({ month, days, today, selected, onSelect, onMonthStep }: MonthCalendarProps) {
  const byDate = new Map(days.map((d) => [d.dateKey, d]));
  const { from, to } = monthBounds(month);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const [focused, setFocused] = useState<string | null>(null);

  const isOpenable = (key: string) => {
    const d = byDate.get(key);
    return !!d && d.status !== 'NOT_EMPLOYED';
  };

  // The one cell in the tab order: the last focused, else the open day, else
  // today, else the latest day that can be opened.
  const openable = days.filter((d) => d.status !== 'NOT_EMPLOYED').map((d) => d.dateKey);
  const tabStop =
    (focused && monthOf(focused) === month && isOpenable(focused) && focused) ||
    (selected && monthOf(selected) === month && isOpenable(selected) && selected) ||
    (isOpenable(today) && monthOf(today) === month && today) ||
    openable[openable.length - 1] ||
    null;

  const moveTo = (key: string) => {
    setFocused(key);
    buttons.current.get(key)?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, key: string) => {
    let delta = 0;
    switch (e.key) {
      case 'ArrowLeft': delta = -1; break;
      case 'ArrowRight': delta = 1; break;
      case 'ArrowUp': delta = -7; break;
      case 'ArrowDown': delta = 7; break;
      case 'Home': delta = -mondayIndex(key); break;
      case 'End': delta = 6 - mondayIndex(key); break;
      case 'PageUp':
      case 'PageDown':
        if (onMonthStep) {
          e.preventDefault();
          onMonthStep(e.key === 'PageUp' ? -1 : 1);
        }
        return;
      default:
        return;
    }
    e.preventDefault();
    if (delta === 0) return;
    let target = addDays(key, delta);
    // Step past days that cannot be opened (future, before employment) when
    // moving one day at a time; a week jump onto one stays put.
    if (Math.abs(delta) === 1) {
      while (target >= from && target <= to && !isOpenable(target)) target = addDays(target, delta);
    }
    if (target >= from && target <= to && isOpenable(target)) moveTo(target);
  };

  // Weeks of 7 cells, blank before the 1st and after the last day.
  const cells: (string | null)[] = Array.from({ length: mondayIndex(from) }, () => null);
  for (let d = from; d <= to; d = addDays(d, 1)) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

  return (
    <div role="grid" aria-label={`Attendance for ${monthLabel(month)}`} className="flex flex-col gap-1 sm:gap-1.5">
      <div role="row" className="grid grid-cols-7 gap-1 sm:gap-1.5">
        {WEEK_HEADERS.map((h, i) => (
          <div
            key={h}
            role="columnheader"
            aria-label={WEEKDAY_NAMES[i]}
            className="pb-0.5 text-center text-[10px] font-bold uppercase tracking-wider text-slate-500"
          >
            {h}
          </div>
        ))}
      </div>

      {weeks.map((week, wi) => (
        <div key={wi} role="row" className="grid grid-cols-7 gap-1 sm:gap-1.5">
          {week.map((key, ci) => {
            if (!key) return <div key={`blank-${wi}-${ci}`} role="gridcell" aria-hidden="true" />;
            const day = byDate.get(key);
            const dayNumber = Number(key.slice(8));

            // Future days (never returned by the server) and days before the
            // employment start are shown but cannot be opened.
            if (!day || day.status === 'NOT_EMPLOYED') {
              const meta = day ? statusMeta(day.status) : null;
              return (
                <div key={key} role="gridcell" aria-disabled="true">
                  <div
                    aria-label={`${longDate(key)}, ${day ? 'before employment started' : 'not yet happened'}`}
                    className={`flex h-14 sm:h-[4.5rem] flex-col justify-between rounded-lg sm:rounded-xl border p-1 sm:p-1.5 ${
                      meta ? meta.cell : 'border-dashed border-white/6 bg-transparent'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-0.5" aria-hidden="true">
                      <span className="text-[11px] sm:text-xs font-bold text-slate-600 tnum">{dayNumber}</span>
                      {meta && <span className={meta.glyph}>{meta.icon('h-3 w-3')}</span>}
                    </div>
                  </div>
                </div>
              );
            }

            const meta = statusMeta(day.status);
            const isSelected = key === selected;
            const deficit = day.deficit.totalMinutes;
            return (
              <div key={key} role="gridcell" aria-selected={isSelected}>
                <button
                  type="button"
                  ref={(el) => {
                    if (el) buttons.current.set(key, el);
                    else buttons.current.delete(key);
                  }}
                  data-day-key={key}
                  tabIndex={key === tabStop ? 0 : -1}
                  aria-label={dayAriaLabel(day)}
                  aria-current={day.isToday ? 'date' : undefined}
                  onClick={() => {
                    setFocused(key);
                    onSelect(key);
                  }}
                  onFocus={() => setFocused(key)}
                  onKeyDown={(e) => onKeyDown(e, key)}
                  className={`group flex h-14 sm:h-[4.5rem] w-full flex-col justify-between rounded-lg sm:rounded-xl border p-1 sm:p-1.5 text-left transition cursor-pointer hover:brightness-125 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400 ${meta.cell} ${
                    isSelected ? 'ring-2 ring-indigo-400 shadow-accent' : ''
                  }`}
                >
                  <span className="flex items-start justify-between gap-0.5" aria-hidden="true">
                    <span className="flex items-center gap-0.5">
                      <span
                        className={`text-[11px] sm:text-xs font-bold tnum leading-none ${
                          day.isToday ? 'rounded-md bg-accent-gradient px-1 py-0.5 text-on-accent' : 'text-slate-200'
                        }`}
                      >
                        {dayNumber}
                      </span>
                      {day.corrections.pending > 0 && <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />}
                    </span>
                    <span className={meta.glyph}>{meta.icon('h-3 w-3 sm:h-3.5 sm:w-3.5')}</span>
                  </span>
                  <span className="flex items-end justify-between gap-0.5" aria-hidden="true">
                    <span className="font-mono text-[9px] sm:text-[11px] font-semibold leading-none text-slate-300 tnum truncate">
                      {day.workedMinutes > 0 ? fmtCompact(day.workedMinutes) : ''}
                    </span>
                    {deficit > 0 && (
                      <>
                        <span className="hidden sm:inline font-mono text-[10px] font-bold leading-none text-rose-400 tnum">
                          −{fmtCompact(deficit)}
                        </span>
                        <span className="sm:hidden h-1.5 w-1.5 shrink-0 rounded-full bg-rose-400" />
                      </>
                    )}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** Loading placeholder with the calendar's shape. */
export function MonthCalendarSkeleton() {
  return (
    <div className="flex flex-col gap-1 sm:gap-1.5" aria-hidden="true">
      <div className="grid grid-cols-7 gap-1 sm:gap-1.5">
        {WEEK_HEADERS.map((h) => (
          <div key={h} className="pb-0.5 text-center text-[10px] font-bold uppercase tracking-wider text-slate-600">
            {h}
          </div>
        ))}
      </div>
      {Array.from({ length: 5 }, (_, w) => (
        <div key={w} className="grid grid-cols-7 gap-1 sm:gap-1.5">
          {Array.from({ length: 7 }, (_, d) => (
            <div key={d} className="h-14 sm:h-[4.5rem] animate-pulse rounded-lg sm:rounded-xl border border-white/6 bg-white/5" />
          ))}
        </div>
      ))}
    </div>
  );
}

export function HistoryLegend() {
  return (
    <div className="flex flex-col gap-2 text-[10px] text-slate-400">
      <ul className="flex flex-wrap gap-x-3 gap-y-1.5" aria-label="Status legend">
        {LEGEND_ORDER.map((s) => {
          const meta = statusMeta(s);
          return (
            <li key={s} className="inline-flex items-center gap-1.5">
              <span className={`flex h-4 w-4 items-center justify-center rounded border ${meta.cell} ${meta.glyph}`} aria-hidden="true">
                {meta.icon('h-2.5 w-2.5')}
              </span>
              {meta.label}
            </li>
          );
        })}
      </ul>
      <ul className="flex flex-wrap gap-x-3 gap-y-1" aria-label="Cell markers">
        <li className="inline-flex items-center gap-1.5">
          <span className="font-mono font-semibold text-slate-300" aria-hidden="true">7h30</span> time worked
        </li>
        <li className="inline-flex items-center gap-1.5">
          <span className="font-mono font-bold text-rose-400" aria-hidden="true">−45m</span>
          <span className="h-1.5 w-1.5 rounded-full bg-rose-400 sm:hidden" aria-hidden="true" />
          deficit
        </li>
        <li className="inline-flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-400" aria-hidden="true" /> pending correction
        </li>
      </ul>
    </div>
  );
}
