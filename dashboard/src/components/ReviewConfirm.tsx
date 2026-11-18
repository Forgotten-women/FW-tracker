'use client';

// Review & Confirm (HR requirements 2026-11-12, section 36.2): before any
// change to annual leave, payroll, absence treatment, deficit settlement or a
// penalty is applied, HR sees the current value, the proposed change, the
// annual leave impact, the payroll impact, the effective date, the reason and
// who approved it - and confirms. Nothing is written until Confirm.

import type { ReactNode } from 'react';
import { Button } from '@/components/primitives';
import { AlertTriangleIcon, CheckCircleIcon, XIcon } from '@/components/icons';

export interface ReviewRow {
  label: string;
  value: ReactNode;
  /** 'warn' colours the value amber, 'danger' rose, 'ok' emerald. */
  tone?: 'warn' | 'danger' | 'ok';
}

interface ReviewConfirmProps {
  title: string;
  subtitle?: string;
  rows: ReviewRow[];
  /** Shown above the rows, e.g. "This action will create a payroll deduction." */
  warnings?: string[];
  /** Shown below the rows, e.g. the insufficient-balance choice. */
  children?: ReactNode;
  confirmLabel?: string;
  busy?: boolean;
  disabled?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onBack: () => void;
}

export function ReviewConfirm({
  title, subtitle, rows, warnings = [], children, confirmLabel = 'Confirm & Apply',
  busy = false, disabled = false, error = null, onConfirm, onBack,
}: ReviewConfirmProps) {
  const toneClass = (t?: ReviewRow['tone']) =>
    t === 'danger' ? 'text-rose-300' : t === 'warn' ? 'text-amber-300' : t === 'ok' ? 'text-emerald-300' : 'text-text';
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold text-text flex items-center gap-2">
            <CheckCircleIcon className="h-4 w-4 text-brand" /> Review &amp; Confirm: {title}
          </h3>
          {subtitle && <p className="text-xs text-muted mt-0.5">{subtitle}</p>}
        </div>
        <button type="button" onClick={onBack} disabled={busy} className="p-1.5 rounded-lg text-muted hover:text-text hover:bg-raised" aria-label="Back">
          <XIcon className="h-4 w-4" />
        </button>
      </div>

      {warnings.map((w) => (
        <div key={w} className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          <AlertTriangleIcon className="h-4 w-4 shrink-0 mt-0.5" /> <span>{w}</span>
        </div>
      ))}

      <dl className="divide-y divide-line rounded-xl border border-line-strong bg-raised text-xs">
        {rows.map((r) => (
          <div key={r.label} className="flex items-start justify-between gap-4 px-3.5 py-2">
            <dt className="text-text-secondary shrink-0">{r.label}</dt>
            <dd className={`text-right font-medium ${toneClass(r.tone)}`}>{r.value}</dd>
          </div>
        ))}
      </dl>

      {children}

      {error && (
        <div role="alert" className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{error}</div>
      )}

      <div className="flex justify-end gap-2 pt-2 border-t border-line">
        <Button onClick={onBack} disabled={busy}>Back</Button>
        <Button variant="success" onClick={onConfirm} disabled={busy || disabled}>
          {busy ? 'Applying…' : confirmLabel}
        </Button>
      </div>
    </div>
  );
}
