'use client';

import { useState } from 'react';
import type { PayrollPreflightCheck, PayrollPreflightSeverity } from '@/lib/types';
import { Badge, Button, Panel } from '@/components/primitives';
import { AlertTriangleIcon, CheckCircleIcon, InfoIcon, RefreshIcon, ShieldCheckIcon } from '@/components/icons';
import { formatDate, humanizeDetail, preflightLabel, type Tone } from './format';

const SEVERITY: Record<PayrollPreflightSeverity, { label: string; tone: Tone; box: string; order: number }> = {
  BLOCKING: { label: 'Blocking', tone: 'danger', box: 'border-rose-500/30 bg-rose-500/5', order: 0 },
  WARNING: { label: 'Warning', tone: 'warn', box: 'border-amber-500/30 bg-amber-500/5', order: 1 },
  INFO: { label: 'Info', tone: 'info', box: 'border-sky-500/25 bg-sky-500/5', order: 2 },
};

const PREVIEW_ITEMS = 5;

function CheckCard({
  check,
  onRegenerate,
  regenerating,
}: {
  check: PayrollPreflightCheck;
  onRegenerate?: () => void;
  regenerating: boolean;
}) {
  const [showAll, setShowAll] = useState(false);
  const sev = SEVERITY[check.severity] ?? SEVERITY.INFO;
  const items = showAll ? check.items : check.items.slice(0, PREVIEW_ITEMS);
  // count is the whole run's; items only name employees this viewer may see.
  const hidden = Math.max(0, check.count - check.items.length);

  return (
    <li className={`rounded-2xl border p-4 ${sev.box}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Badge tone={sev.tone} size="sm">
            {check.severity === 'INFO' ? <InfoIcon className="h-3 w-3" /> : <AlertTriangleIcon className="h-3 w-3" />}
            {sev.label}
          </Badge>
          <h4 className="text-sm font-bold text-white">{preflightLabel(check.code)}</h4>
          {check.count > 0 && (
            <span className="rounded-md border border-white/10 bg-white/5 px-1.5 py-0.5 font-mono text-[11px] font-bold text-slate-300 tnum">
              {check.count}
            </span>
          )}
        </div>
        {check.code === 'NEW_DEDUCTIONS_SINCE_GENERATION' && onRegenerate && (
          <Button
            size="sm"
            variant="secondary"
            onClick={onRegenerate}
            disabled={regenerating}
            icon={<RefreshIcon className={`h-3.5 w-3.5 ${regenerating ? 'animate-spin' : ''}`} />}
          >
            {regenerating ? 'Generating…' : 'Generate deductions again'}
          </Button>
        )}
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-slate-400">{check.message}</p>

      {items.length > 0 && (
        <ul className="mt-3 divide-y divide-white/5 overflow-hidden rounded-xl border border-white/8 bg-slate-950/30">
          {items.map((item, i) => (
            <li
              key={`${item.ref ?? item.employeeId}-${i}`}
              className="flex flex-col gap-0.5 px-3 py-2 text-xs sm:flex-row sm:items-center sm:gap-3"
            >
              <span className="min-w-0 font-semibold text-slate-200 sm:w-44 sm:shrink-0 sm:truncate">
                {item.employeeName ?? 'Employee not in this run'}
              </span>
              <span className="text-slate-400 tnum sm:w-28 sm:shrink-0">{item.date ? formatDate(item.date) : '—'}</span>
              <span className="min-w-0 text-slate-400">{humanizeDetail(item.detail)}</span>
            </li>
          ))}
        </ul>
      )}
      {(check.items.length > PREVIEW_ITEMS || hidden > 0) && (
        <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
          {check.items.length > PREVIEW_ITEMS && (
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="font-semibold text-indigo-300 hover:text-indigo-200 cursor-pointer"
            >
              {showAll ? 'Show fewer' : `Show all ${check.items.length}`}
            </button>
          )}
          {hidden > 0 && <span>{hidden} more for employees you cannot see.</span>}
        </div>
      )}
    </li>
  );
}

/**
 * What would make approving the run wrong right now. BLOCKING checks stop the
 * approval unless it carries an explicit, audited waiver.
 */
export function PreflightPanel({
  checks,
  onRegenerate,
  regenerating,
  notice,
}: {
  checks: PayrollPreflightCheck[];
  onRegenerate?: () => void;
  regenerating: boolean;
  notice?: { tone: 'ok' | 'danger'; text: string } | null;
}) {
  const sorted = [...checks].sort((a, b) => (SEVERITY[a.severity]?.order ?? 9) - (SEVERITY[b.severity]?.order ?? 9));
  const blocking = checks.filter((c) => c.severity === 'BLOCKING').length;
  const warnings = checks.filter((c) => c.severity === 'WARNING').length;

  return (
    <Panel
      title="Preflight checks"
      subtitle="Anything that would make approving this run wrong right now"
      icon={<ShieldCheckIcon className="h-5 w-5" />}
      actions={
        checks.length > 0 ? (
          <>
            <Badge tone={blocking > 0 ? 'danger' : 'muted'} size="sm">{blocking} blocking</Badge>
            <Badge tone={warnings > 0 ? 'warn' : 'muted'} size="sm">{warnings} warning{warnings === 1 ? '' : 's'}</Badge>
          </>
        ) : undefined
      }
    >
      {notice && (
        <div
          className={`mb-3 rounded-xl border px-3.5 py-2.5 text-xs ${
            notice.tone === 'ok'
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
              : 'border-rose-500/30 bg-rose-500/10 text-rose-300'
          }`}
        >
          {notice.text}
        </div>
      )}
      {sorted.length === 0 ? (
        <div className="flex items-center gap-3 rounded-2xl border border-emerald-500/25 bg-emerald-500/5 px-4 py-3">
          <CheckCircleIcon className="h-5 w-5 shrink-0 text-emerald-400" />
          <p className="text-xs text-slate-300">
            Nothing blocks this run: no pending corrections, absence reviews or leave requests up to the cut-off, no
            deductions missing from the run, and every employee has a salary.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {sorted.map((c) => (
            <CheckCard key={c.code} check={c} onRegenerate={onRegenerate} regenerating={regenerating} />
          ))}
        </ul>
      )}
    </Panel>
  );
}
