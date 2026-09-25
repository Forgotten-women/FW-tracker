'use client';

// The drawer's History tab: any day for one employee, back to the start of
// their employment. A month is fetched at a time (the API allows 62 days a
// call) and kept in the drawer's store; the day detail is fetched on open.

import { useRef, type ReactNode } from 'react';
import { Button, Empty } from '@/components/primitives';
import {
  AlertTriangleIcon,
  CalendarIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleSlashIcon,
  DownloadIcon,
  LayoutGridIcon,
  ListIcon,
  RefreshIcon,
} from '@/components/icons';
import { DayDetailPanel } from './DayDetailPanel';
import { HistoryLegend, MonthCalendar, MonthCalendarSkeleton } from './MonthCalendar';
import { MonthTable } from './MonthTable';
import {
  type HistoryMode,
  type HistoryView,
  addDays,
  addMonths,
  buildHistoryCsv,
  downloadCsv,
  fmtMinutes,
  isDateKey,
  mediumDate,
  monthBounds,
  monthLabel,
  monthOf,
  monthTotals,
  monthsBetween,
  slug,
} from './historyMeta';
import { knownEmploymentStart, useHistoryDay, useHistoryMonth, type HistoryStore } from './historyStore';

// With no employment start on record there is no natural floor; months are
// still reachable, just not listed endlessly.
const UNKNOWN_START_LOOKBACK_MONTHS = 60;

interface EmployeeHistoryProps {
  employeeId: string;
  employeeName: string;
  /** Today's YYYY-MM-DD in the office timezone. */
  today: string;
  store: HistoryStore;
  /** null = this month, nothing open. */
  view: HistoryView | null;
  onViewChange: (view: HistoryView) => void;
  onViewScreenshots: (dateKey: string) => void;
}

function Tile({ label, value, tone = 'text-white', hint }: { label: string; value: ReactNode; tone?: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-white/8 bg-white/5 px-3 py-2.5">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{label}</div>
      <div className={`mt-0.5 font-mono text-lg font-bold leading-tight tnum ${tone}`}>{value}</div>
      {hint && <div className="text-[10px] text-slate-500 truncate">{hint}</div>}
    </div>
  );
}

function TotalsSkeleton() {
  return (
    <div className="grid grid-cols-3 gap-2" aria-hidden="true">
      {Array.from({ length: 9 }, (_, i) => (
        <div key={i} className="h-[62px] animate-pulse rounded-xl border border-white/6 bg-white/5" />
      ))}
    </div>
  );
}

export function EmployeeHistory({
  employeeId,
  employeeName,
  today,
  store,
  view,
  onViewChange,
  onViewScreenshots,
}: EmployeeHistoryProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const todayMonth = monthOf(today);

  const requested = view ?? { month: todayMonth, day: null, mode: 'calendar' as HistoryMode };
  const month = requested.month > todayMonth ? todayMonth : requested.month;
  const mode = requested.mode;
  const openDay = requested.day && requested.day <= today ? requested.day : null;
  const live = month === todayMonth;

  const monthRes = useHistoryMonth(store, employeeId, month, live);
  const dayRes = useHistoryDay(store, employeeId, openDay, openDay === today);

  const { start } = knownEmploymentStart(store, employeeId);
  const employmentStart = monthRes.data?.employmentStart ?? start;
  const startMonth = employmentStart ? monthOf(employmentStart) : null;
  const floorMonth = startMonth ?? addMonths(todayMonth, -UNKNOWN_START_LOOKBACK_MONTHS);

  const canPrev = startMonth ? month > startMonth : true;
  const canNext = month < todayMonth;

  const set = (patch: Partial<HistoryView>) => onViewChange({ month, day: openDay, mode, ...patch });

  const goMonth = (m: string) => {
    let target = m > todayMonth ? todayMonth : m;
    if (startMonth && target < startMonth) target = startMonth;
    set({ month: target, day: null });
  };

  const focusIn = (selector: string) => {
    requestAnimationFrame(() => rootRef.current?.querySelector<HTMLElement>(selector)?.focus());
  };

  const stepMonth = (delta: -1 | 1) => {
    if ((delta < 0 && !canPrev) || (delta > 0 && !canNext)) return;
    goMonth(addMonths(month, delta));
    focusIn('[data-month-select]');
  };

  const openDate = (dateKey: string) => {
    let d = dateKey > today ? today : dateKey;
    if (employmentStart && d < employmentStart) d = employmentStart;
    set({ month: monthOf(d), day: d });
  };

  const closeDay = () => {
    const was = openDay;
    set({ day: null });
    if (was) focusIn(`[data-day-key="${was}"]`);
  };

  const prevDay = openDay && (!employmentStart || addDays(openDay, -1) >= employmentStart) ? () => openDate(addDays(openDay, -1)) : null;
  const nextDay = openDay && addDays(openDay, 1) <= today ? () => openDate(addDays(openDay, 1)) : null;

  const data = monthRes.data;
  const days = data?.days ?? [];
  const totals = monthTotals(days);
  const beforeEmployment = !!(data?.employmentStart && monthBounds(month).to < data.employmentStart);
  const openSummary = openDay ? days.find((d) => d.dateKey === openDay) ?? null : null;

  const monthOptions = monthsBetween(floorMonth < month ? floorMonth : month, todayMonth);

  const exportCsv = () => {
    if (!data || days.length === 0) return;
    const name = data.employee?.name || employeeName;
    downloadCsv(`attendance-history-${slug(name)}-${month}.csv`, buildHistoryCsv(days));
  };

  const refresh = () => {
    monthRes.reload();
    if (openDay) dayRes.reload();
  };

  return (
    <div ref={rootRef} className="space-y-4">
      {/* Toolbar: month navigation, jump, view and export */}
      <div className="glass-panel rounded-2xl p-3 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => stepMonth(-1)}
              disabled={!canPrev}
              aria-label="Previous month"
              title={canPrev ? 'Previous month' : 'Employment started this month'}
              icon={<ChevronLeftIcon className="h-4 w-4" />}
            />
            <label className="sr-only" htmlFor={`history-month-${employeeId}`}>Month</label>
            <select
              id={`history-month-${employeeId}`}
              data-month-select
              value={month}
              onChange={(e) => goMonth(e.target.value)}
              className="rounded-xl border border-white/10 bg-slate-950 px-2.5 py-1.5 text-xs font-bold text-white focus:border-indigo-500/70 focus:outline-none focus:ring-4 focus:ring-indigo-500/15 cursor-pointer"
            >
              {monthOptions.map((m) => (
                <option key={m} value={m}>{monthLabel(m)}</option>
              ))}
            </select>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => stepMonth(1)}
              disabled={!canNext}
              aria-label="Next month"
              icon={<ChevronRightIcon className="h-4 w-4" />}
            />
            {month !== todayMonth && (
              <Button variant="ghost" size="sm" onClick={() => goMonth(todayMonth)}>
                This month
              </Button>
            )}
          </div>

          <div className="flex items-center rounded-xl border border-white/10 bg-white/5 p-1" role="group" aria-label="History layout">
            {([
              ['calendar', 'Calendar', <LayoutGridIcon key="c" className="h-3.5 w-3.5" />],
              ['list', 'List', <ListIcon key="l" className="h-3.5 w-3.5" />],
            ] as const).map(([m, label, icon]) => (
              <button
                key={m}
                type="button"
                onClick={() => set({ mode: m })}
                aria-pressed={mode === m}
                className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-bold transition cursor-pointer ${
                  mode === m ? 'bg-accent-gradient text-on-accent shadow-accent' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {icon}
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/8 pt-3">
          <label className="flex items-center gap-2 text-xs text-slate-300">
            <CalendarIcon className="h-3.5 w-3.5 shrink-0 text-slate-400" />
            <span>Jump to date</span>
            <input
              type="date"
              value={openDay ?? ''}
              min={employmentStart ?? undefined}
              max={today}
              onChange={(e) => {
                if (isDateKey(e.target.value)) openDate(e.target.value);
              }}
              className="rounded-xl border border-slate-700 bg-slate-950 px-2.5 py-1 text-xs text-white focus:border-indigo-500 focus:outline-none cursor-pointer"
            />
          </label>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={refresh}
              disabled={monthRes.loading}
              aria-label="Reload this month"
              title="Reload this month"
              icon={<RefreshIcon className="h-3.5 w-3.5" />}
            />
            <Button
              variant="accent"
              size="sm"
              onClick={exportCsv}
              disabled={!data || days.length === 0 || beforeEmployment}
              icon={<DownloadIcon className="h-3.5 w-3.5" />}
            >
              Export month CSV
            </Button>
          </div>
        </div>

        <p className="text-[11px] text-slate-500">
          {employmentStart ? (
            <>Employment started {mediumDate(employmentStart)}.</>
          ) : data ? (
            <>No employment start date is on record, so days before {employeeName} joined may show as absent.</>
          ) : null}
          {live && <> This month is refreshed every 2 minutes while open.</>}
        </p>
      </div>

      {/* Month */}
      {monthRes.error ? (
        <div role="alert" className="glass-panel flex flex-col items-center gap-3 rounded-2xl border border-rose-500/30 p-6 text-center">
          <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-rose-500/15 text-rose-400">
            <AlertTriangleIcon className="h-5 w-5" />
          </span>
          <div>
            <p className="text-sm font-semibold text-white">Could not load {monthLabel(month)}</p>
            <p className="mt-1 text-xs text-rose-300">{monthRes.error}</p>
          </div>
          <Button variant="secondary" size="sm" onClick={monthRes.reload} icon={<RefreshIcon className="h-3.5 w-3.5" />}>
            Retry
          </Button>
        </div>
      ) : !data ? (
        <div className="space-y-4" aria-busy="true">
          <span className="sr-only" role="status">Loading {monthLabel(month)}…</span>
          <TotalsSkeleton />
          <div className="glass-panel rounded-2xl p-3 sm:p-4">
            <MonthCalendarSkeleton />
          </div>
        </div>
      ) : beforeEmployment ? (
        <Empty
          icon={<CircleSlashIcon className="h-6 w-6" />}
          title={`Not yet employed in ${monthLabel(month)}`}
          description={`${data.employee?.name || employeeName} started on ${mediumDate(data.employmentStart as string)}, so there is no attendance to show for this month.`}
          action={
            <Button variant="accent" size="sm" onClick={() => goMonth(monthOf(data.employmentStart as string))}>
              Go to {monthLabel(monthOf(data.employmentStart as string))}
            </Button>
          }
        />
      ) : days.length === 0 ? (
        <Empty title={`No days to show for ${monthLabel(month)}`} description="Nothing has been recorded for this period yet." />
      ) : (
        <>
          <section aria-label={`${monthLabel(month)} totals`} className="grid grid-cols-3 gap-2">
            <Tile label="Present" value={totals.present} tone="text-emerald-400" hint={`of ${totals.workingDays} working days`} />
            <Tile label="On time" value={totals.onTime} tone="text-emerald-400" />
            <Tile label="Late" value={totals.late} tone={totals.late > 0 ? 'text-amber-300' : 'text-slate-400'} />
            <Tile label="Short" value={totals.short} tone={totals.short > 0 ? 'text-orange-300' : 'text-slate-400'} />
            <Tile label="Absent" value={totals.absent} tone={totals.absent > 0 ? 'text-rose-400' : 'text-slate-400'} />
            <Tile label="Leave days" value={totals.leaveDays} tone={totals.leaveDays > 0 ? 'text-sky-300' : 'text-slate-400'} />
            <Tile label="Worked" value={fmtMinutes(totals.workedMinutes)} tone="text-white" />
            <Tile
              label="Deficit"
              value={totals.deficitMinutes > 0 ? `−${fmtMinutes(totals.deficitMinutes)}` : '0m'}
              tone={totals.deficitMinutes > 0 ? 'text-rose-400' : 'text-slate-400'}
            />
            <Tile
              label="Pending corr."
              value={totals.pendingCorrections}
              tone={totals.pendingCorrections > 0 ? 'text-amber-300' : 'text-slate-400'}
              hint={totals.pendingCorrections > 0 ? 'awaiting HR review' : undefined}
            />
          </section>

          <div className="glass-panel rounded-2xl p-3 sm:p-4 space-y-4">
            {mode === 'calendar' ? (
              <>
                <MonthCalendar
                  month={month}
                  days={days}
                  today={today}
                  selected={openDay}
                  onSelect={(k) => set({ day: k })}
                  onMonthStep={stepMonth}
                />
                <HistoryLegend />
              </>
            ) : (
              <MonthTable days={days} selected={openDay} onSelect={(k) => set({ day: k })} />
            )}
          </div>
        </>
      )}

      {/* Day */}
      {openDay && !beforeEmployment && !monthRes.error && openSummary?.status !== 'NOT_EMPLOYED' && (
        <DayDetailPanel
          dateKey={openDay}
          summary={openSummary}
          detail={dayRes.data}
          loading={dayRes.loading}
          error={dayRes.error}
          onRetry={dayRes.reload}
          onClose={closeDay}
          onPrev={prevDay}
          onNext={nextDay}
          onViewScreenshots={onViewScreenshots}
        />
      )}
    </div>
  );
}
