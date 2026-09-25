'use client';

// The month as rows, for reading figures side by side. Same data as the
// calendar; each row opens the day.

import type { HistoryDaySummary } from '@/lib/types';
import { dayAriaLabel, fmtMinutes, shortDate, statusMeta } from './historyMeta';

interface MonthTableProps {
  days: HistoryDaySummary[];
  selected: string | null;
  onSelect: (dateKey: string) => void;
}

export function MonthTable({ days, selected, onSelect }: MonthTableProps) {
  const rows = days.filter((d) => d.status !== 'NOT_EMPLOYED');
  if (rows.length === 0) {
    return <p className="py-6 text-center text-xs text-slate-500">No days in this month fall within the employment period.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-white/8">
      <table className="w-full min-w-[640px] border-collapse text-left text-xs">
        <caption className="sr-only">Daily attendance, one row per day. Choose a date to open the day.</caption>
        <thead className="bg-white/5 text-[10px] font-bold uppercase tracking-wider text-slate-400 border-b border-white/8">
          <tr>
            <th scope="col" className="px-3 py-2.5">Date</th>
            <th scope="col" className="px-2 py-2.5">Status</th>
            <th scope="col" className="px-2 py-2.5">In</th>
            <th scope="col" className="px-2 py-2.5">Out</th>
            <th scope="col" className="px-2 py-2.5 text-right">Worked</th>
            <th scope="col" className="px-2 py-2.5 text-right">Break</th>
            <th scope="col" className="px-2 py-2.5 text-right">Deficit</th>
            <th scope="col" className="px-2 py-2.5 text-right">Laptop</th>
            <th scope="col" className="px-3 py-2.5 text-right">Corr.</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/6">
          {rows.map((d) => {
            const meta = statusMeta(d.status);
            const isSelected = d.dateKey === selected;
            return (
              <tr
                key={d.dateKey}
                onClick={() => onSelect(d.dateKey)}
                className={`cursor-pointer transition-colors ${isSelected ? 'bg-indigo-500/10' : 'hover:bg-indigo-500/[0.05]'}`}
              >
                <td className="px-3 py-2 whitespace-nowrap">
                  <button
                    type="button"
                    data-day-key={d.dateKey}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelect(d.dateKey);
                    }}
                    aria-label={`Open ${dayAriaLabel(d)}`}
                    aria-current={isSelected ? 'true' : undefined}
                    className="font-semibold text-white hover:text-indigo-300 rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400 cursor-pointer"
                  >
                    {shortDate(d.dateKey)}
                  </button>
                  {d.isToday && <span className="ml-1.5 text-[10px] font-bold text-indigo-300">Today</span>}
                </td>
                <td className="px-2 py-2">
                  <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                    <span className={`flex h-5 w-5 items-center justify-center rounded-md border ${meta.cell} ${meta.glyph}`} aria-hidden="true">
                      {meta.icon('h-3 w-3')}
                    </span>
                    <span className="text-slate-200">{d.statusLabel || meta.label}</span>
                  </span>
                </td>
                <td className="px-2 py-2 font-mono text-slate-300 whitespace-nowrap">{d.firstIn ?? '—'}</td>
                <td className="px-2 py-2 font-mono text-slate-300 whitespace-nowrap">{d.lastOut ?? '—'}</td>
                <td className="px-2 py-2 text-right font-mono font-semibold text-emerald-400 tnum whitespace-nowrap">
                  {d.workedMinutes > 0 ? fmtMinutes(d.workedMinutes) : '—'}
                </td>
                <td className="px-2 py-2 text-right font-mono text-slate-300 tnum">{d.breakMinutes > 0 ? `${d.breakMinutes}m` : '—'}</td>
                <td className={`px-2 py-2 text-right font-mono tnum whitespace-nowrap ${d.deficit.totalMinutes > 0 ? 'font-bold text-rose-400' : 'text-slate-500'}`}>
                  {d.deficit.totalMinutes > 0 ? `−${fmtMinutes(d.deficit.totalMinutes)}` : '0m'}
                </td>
                <td className="px-2 py-2 text-right font-mono text-slate-300 tnum whitespace-nowrap">
                  {d.laptop ? fmtMinutes(d.laptop.activeMinutes) : '—'}
                </td>
                <td className="px-3 py-2 text-right tnum">
                  {d.corrections.pending > 0 ? (
                    <span className="rounded-md bg-amber-500/15 px-1.5 py-0.5 font-bold text-amber-300">{d.corrections.pending} pending</span>
                  ) : d.corrections.total > 0 ? (
                    <span className="text-slate-400">{d.corrections.total}</span>
                  ) : (
                    <span className="text-slate-600">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
