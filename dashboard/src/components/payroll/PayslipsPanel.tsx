'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { Payslip, PayrollPeriodStatus } from '@/lib/types';
import { Badge, Button, Empty, Input, Panel } from '@/components/primitives';
import {
  AlertTriangleIcon,
  BanknoteIcon,
  CheckIcon,
  ChevronDownIcon,
  FileTextIcon,
  RefreshIcon,
  SearchIcon,
  ShieldCheckIcon,
} from '@/components/icons';
import {
  type Currency,
  type RunErrorView,
  describeRunError,
  formatActor,
  formatDate,
  formatMoney,
  formatSignedMoney,
  formatSum,
  formatTimestamp,
  sumAcrossCurrencies,
} from './format';

// ---------------------------------------------------------------------------
// Mark as paid
// ---------------------------------------------------------------------------

function MarkPaidCard({
  periodId,
  payDate,
  payslipCount,
  onDone,
}: {
  periodId: string;
  payDate: string | null;
  payslipCount: number;
  onDone: (notice: { tone: 'ok' | 'danger'; text: string }) => void;
}) {
  const [note, setNote] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<RunErrorView | null>(null);

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const r = await api.markPayrollPaid(periodId, note.trim());
      onDone({
        tone: 'ok',
        text: `Marked as paid on ${formatTimestamp(r.paidAt)}. ${r.payslipsMarked} payslip${r.payslipsMarked === 1 ? '' : 's'} stamped as paid.`,
      });
    } catch (e) {
      const view = describeRunError(e, 'pay');
      if (view.code === 'ALREADY_FINAL' || view.code === 'NOT_PUBLISHED' || view.code === 'NOT_FOUND') {
        // The run moved on without this request (someone else marked it
        // paid): this card goes away with the refresh, so say why above it.
        onDone({ tone: 'danger', text: `${view.title} ${view.message}` });
      } else {
        setError(view);
      }
    } finally {
      setSaving(false);
      setConfirming(false);
    }
  };

  return (
    <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/5 p-4">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-400">
          <BanknoteIcon className="h-4.5 w-4.5" />
        </span>
        <div className="min-w-0">
          <h4 className="text-sm font-bold text-white">Mark as paid</h4>
          <p className="text-xs text-slate-400">
            Once the money has gone out{payDate ? ` (pay date ${formatDate(payDate)})` : ''}. This stamps all{' '}
            {payslipCount} payslip{payslipCount === 1 ? '' : 's'} as paid; it changes none of their figures.
          </p>
        </div>
      </div>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
        <label className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-[11px] font-semibold text-slate-400">Payment note (required)</span>
          <Input
            value={note}
            onChange={(ev) => setNote(ev.target.value)}
            placeholder="e.g. Bank batch reference"
            className="py-2"
            maxLength={500}
          />
        </label>
        {confirming ? (
          <div className="flex shrink-0 gap-2">
            <Button variant="secondary" onClick={() => setConfirming(false)} disabled={saving}>Cancel</Button>
            <Button variant="success" onClick={submit} disabled={saving || !note.trim()} icon={<CheckIcon className="h-4 w-4" />}>
              {saving ? 'Saving…' : 'Confirm paid'}
            </Button>
          </div>
        ) : (
          <Button
            variant="success"
            className="shrink-0"
            disabled={!note.trim() || saving}
            onClick={() => setConfirming(true)}
            icon={<BanknoteIcon className="h-4 w-4" />}
          >
            Mark as paid
          </Button>
        )}
      </div>
      {confirming && <p className="mt-2 text-[11px] text-slate-400">This cannot be undone.</p>}
      {error && (
        <div role="alert" className="mt-3 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3.5 py-2.5 text-xs">
          <p className="font-bold text-rose-300">{error.title}</p>
          <p className="mt-0.5 text-rose-200/90">{error.message}</p>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One payslip
// ---------------------------------------------------------------------------

function PayslipCard({ slip, currency }: { slip: Payslip; currency: Currency }) {
  const [open, setOpen] = useState(false);
  const fmt = (n: number) => formatMoney(n, currency, slip.currency, slip.exchangeRate);
  const fmtSigned = (n: number) => formatSignedMoney(n, currency, slip.currency, slip.exchangeRate);

  return (
    <li className={`rounded-2xl border bg-white/3 ${slip.integrityOk ? 'border-white/10' : 'border-rose-500/50'}`}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full flex-col gap-3 p-4 text-left sm:flex-row sm:items-center sm:justify-between cursor-pointer"
      >
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-bold text-white">{slip.employeeName ?? slip.employeeId}</span>
            {slip.employeeNumber && (
              <span className="rounded-md border border-indigo-500/30 bg-indigo-500/15 px-1.5 py-0.5 font-mono text-[10px] font-bold text-indigo-300">
                {slip.employeeNumber}
              </span>
            )}
            <Badge tone={slip.payslipStatus === 'PAID' ? 'ok' : 'accent'} size="sm">
              {slip.payslipStatus === 'PAID' ? 'Paid' : 'Published'}
            </Badge>
            {slip.integrityOk ? (
              <Badge tone="ok" size="sm"><ShieldCheckIcon className="h-3 w-3" /> Integrity verified</Badge>
            ) : (
              <Badge tone="danger" size="sm"><AlertTriangleIcon className="h-3 w-3" /> Altered after publishing</Badge>
            )}
            {slip.isPartial && <Badge tone="info" size="sm">Partial period</Badge>}
            {slip.isStarter && <Badge tone="info" size="sm">Starter</Badge>}
          </div>
          <p className="mt-1 text-[11px] text-slate-500">
            {slip.lines.length} line{slip.lines.length === 1 ? '' : 's'} · {slip.workingDays} of {slip.fullPeriodDays} working
            days · v{slip.version} · {slip.currency}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-4">
          <dl className="grid grid-cols-3 gap-x-4 text-right">
            <dt className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Gross</dt>
            <dt className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Deductions</dt>
            <dt className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Net</dt>
            <dd className="font-mono text-xs text-slate-300 tnum">{fmt(slip.grossBaseline)}</dd>
            <dd className="font-mono text-xs text-rose-400 tnum">{slip.deductionsTotal > 0 ? fmt(-slip.deductionsTotal) : '—'}</dd>
            <dd className="font-mono text-sm font-bold text-emerald-400 tnum">{fmt(slip.netPayable)}</dd>
          </dl>
          <ChevronDownIcon className={`h-4 w-4 shrink-0 text-slate-500 transition-transform ${open ? 'rotate-180' : ''}`} />
        </div>
      </button>

      {open && (
        <div className="border-t border-white/8 p-4">
          {slip.lines.length === 0 ? (
            <p className="text-xs text-slate-500">No approved lines: paid the gross baseline.</p>
          ) : (
            <ul className="divide-y divide-white/5 overflow-hidden rounded-xl border border-white/8">
              {slip.lines.map((l) => (
                <li key={l.adjustmentId} className="flex flex-col gap-1 px-3 py-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-slate-200">
                      {l.label}
                      {l.date && <span className="ml-1.5 font-normal text-slate-500">{formatDate(l.date)}</span>}
                      {l.days != null && l.days > 0 && (
                        <span className="ml-1.5 font-normal text-slate-500">{l.days} day{l.days === 1 ? '' : 's'}</span>
                      )}
                    </div>
                    <p className="text-[11px] text-slate-500">{l.explanation}</p>
                  </div>
                  <span className={`shrink-0 font-mono text-xs tnum ${l.amount < 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                    {fmtSigned(l.amount)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
            <div><dt className="text-slate-500">Monthly salary</dt><dd className="font-mono text-slate-300 tnum">{fmt(slip.monthlySalary)}</dd></div>
            <div><dt className="text-slate-500">Daily rate</dt><dd className="font-mono text-slate-300 tnum">{fmt(slip.dailyRate)}</dd></div>
            <div><dt className="text-slate-500">Adjustments total</dt><dd className="font-mono text-slate-300 tnum">{fmtSigned(slip.adjustmentsTotal)}</dd></div>
            <div><dt className="text-slate-500">Salary from</dt><dd className="text-slate-300">{formatDate(slip.salaryEffectiveFrom)}</dd></div>
            <div><dt className="text-slate-500">Published</dt><dd className="text-slate-300">{formatTimestamp(slip.publishedAt)}</dd><dd className="text-[10px] text-slate-500">by {formatActor(slip.publishedBy)}</dd></div>
            <div><dt className="text-slate-500">Paid</dt><dd className="text-slate-300">{formatTimestamp(slip.paidAt)}</dd></div>
            <div><dt className="text-slate-500">Exchange rate</dt><dd className="font-mono text-slate-300 tnum">£1 = ₨{slip.exchangeRate.toFixed(2)}</dd></div>
            <div className="min-w-0">
              <dt className="text-slate-500">Content hash</dt>
              <dd className="truncate font-mono text-[11px] text-slate-400" title={slip.contentHash}>{slip.contentHash.slice(0, 16)}…</dd>
            </div>
          </dl>
          {!slip.integrityOk && (
            <p className="mt-3 flex items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
              <AlertTriangleIcon className="mt-px h-4 w-4 shrink-0" />
              The stored figures no longer match the hash taken when this payslip was published: the row was changed
              afterwards. Do not rely on it until the change is explained.
            </p>
          )}
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

/** Published runs: mark as paid, and every payslip the run wrote. */
export function PayslipsPanel({
  periodId,
  status,
  payDate,
  refreshKey,
  currency,
  onChanged,
}: {
  periodId: string;
  status: PayrollPeriodStatus;
  payDate: string | null;
  refreshKey: number;
  currency: Currency;
  onChanged: () => void;
}) {
  const [slips, setSlips] = useState<Payslip[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [reloadTick, setReloadTick] = useState(0);
  const [search, setSearch] = useState('');
  const [notice, setNotice] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.payrollPayslips(periodId);
        if (cancelled) return;
        setSlips(res.payslips ?? []);
        setLoadError('');
      } catch (e) {
        if (cancelled) return;
        setLoadError(e instanceof Error ? e.message : 'Could not load the payslips.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [periodId, refreshKey, reloadTick, status]);

  const failing = slips ? slips.filter((s) => !s.integrityOk).length : 0;
  const q = search.trim().toLowerCase();
  const shown = (slips ?? []).filter(
    (s) => !q || (s.employeeName ?? '').toLowerCase().includes(q) || (s.employeeNumber ?? '').toLowerCase().includes(q),
  );
  const netTotal = slips && slips.length
    ? formatSum(sumAcrossCurrencies(slips.map((s) => ({ amount: s.netPayable, currency: s.currency })), currency, slips[0].exchangeRate))
    : null;

  return (
    <Panel
      title="Payslips"
      subtitle="Written once when the run was approved. They cannot be edited."
      icon={<FileTextIcon className="h-5 w-5" />}
      actions={
        <Button size="sm" variant="ghost" onClick={() => setReloadTick((t) => t + 1)} icon={<RefreshIcon className="h-3.5 w-3.5" />}>
          Refresh
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        {status === 'PUBLISHED' && (
          <MarkPaidCard
            periodId={periodId}
            payDate={payDate}
            payslipCount={slips?.length ?? 0}
            onDone={(n) => {
              setNotice(n);
              setReloadTick((t) => t + 1);
              onChanged();
            }}
          />
        )}

        {notice && (
          <div
            role="status"
            className={`rounded-xl border px-3.5 py-2.5 text-xs ${
              notice.tone === 'ok'
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                : 'border-rose-500/30 bg-rose-500/10 text-rose-300'
            }`}
          >
            {notice.text}
          </div>
        )}

        {loadError && (
          <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3.5 py-2.5 text-xs text-rose-300">
            <AlertTriangleIcon className="inline-block h-3.5 w-3.5" /> {loadError}
          </div>
        )}

        {slips === null && !loadError ? (
          <div className="flex h-24 items-center justify-center">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent" />
          </div>
        ) : slips && slips.length === 0 ? (
          <Empty title="No payslips" description="This run has no payslips you can see." icon={<FileTextIcon className="h-6 w-6" />} />
        ) : slips ? (
          <>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="muted">{slips.length} payslip{slips.length === 1 ? '' : 's'}</Badge>
                {netTotal && <Badge tone="ok">Net {netTotal}</Badge>}
                {failing === 0 ? (
                  <Badge tone="ok"><ShieldCheckIcon className="h-3.5 w-3.5" /> All pass the integrity check</Badge>
                ) : (
                  <Badge tone="danger"><AlertTriangleIcon className="h-3.5 w-3.5" /> {failing} altered after publishing</Badge>
                )}
              </div>
              <div className="w-full sm:w-64">
                <Input
                  value={search}
                  onChange={(ev) => setSearch(ev.target.value)}
                  placeholder="Find a payslip"
                  icon={<SearchIcon className="h-4 w-4" />}
                  className="py-2"
                  aria-label="Find a payslip"
                />
              </div>
            </div>
            {shown.length === 0 ? (
              <Empty title="No payslips match" description="Clear the search to see them all." />
            ) : (
              <ul className="flex flex-col gap-2">
                {shown.map((s) => (
                  <PayslipCard key={s.id} slip={s} currency={currency} />
                ))}
              </ul>
            )}
          </>
        ) : null}
      </div>
    </Panel>
  );
}
