'use client';

/**
 * The monthly invoice, on screen.
 *
 * Mirrors the Word template HR uploads (layout and wording), filled from the
 * same server-formatted fields the .docx is filled from, so what HR sees here
 * is what the employee gets. Nothing is calculated in the browser.
 *
 * Final for a published / paid month; a live draft ("Provisional") for an
 * open or in-review one. "Save PDF" prints just the sheet: see the invoice
 * print rules at the end of app/globals.css.
 */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ApiError, api } from '@/lib/api';
import type { DownloadedFile, InvoiceStatement } from '@/lib/types';
import { Badge, Button } from '@/components/primitives';
import {
  AlertTriangleIcon,
  DownloadIcon,
  FileTextIcon,
  RefreshIcon,
  ShieldCheckIcon,
  XIcon,
} from '@/components/icons';
import { PERIOD_STATUS_META, formatDate } from './format';

// ---------------------------------------------------------------------------
// Shared helpers (also used by the payslips panel and invoice settings)
// ---------------------------------------------------------------------------

/** Hands a fetched file to the browser as a download. */
export function saveBlob({ blob, fileName }: Pick<DownloadedFile, 'blob' | 'fileName'>) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a moment to start the download before the URL goes.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export interface InvoiceErrorView {
  code: string | null;
  title: string;
  message: string;
}

const NO_TEMPLATE_MESSAGE =
  'No invoice template has been uploaded yet. Upload a Word (.docx) template under Invoice settings on the Payroll page, then try again.';

/** A refused invoice or template call, worded for HR. */
export function describeInvoiceError(
  err: unknown,
  action: 'view' | 'docx' | 'zip' | 'upload' | 'template',
): InvoiceErrorView {
  const fallback = {
    view: 'The invoice could not be shown.',
    docx: 'The Word invoice could not be downloaded.',
    zip: 'The invoices could not be downloaded.',
    upload: 'The template was not uploaded.',
    template: 'The template could not be loaded.',
  }[action];

  if (!(err instanceof ApiError)) {
    return {
      code: null,
      title: fallback,
      message: err instanceof Error && err.message ? err.message : 'Could not reach the server.',
    };
  }

  switch (err.code) {
    case 'INVOICE_MISMATCH':
      return {
        code: err.code,
        title: 'Invoice refused: the figures do not add up.',
        message: `${err.message} Check this employee's lines in the payroll run before issuing an invoice.`,
      };
    case 'NO_TEMPLATE':
      return { code: err.code, title: 'No invoice template uploaded.', message: NO_TEMPLATE_MESSAGE };
    case 'NO_SALARY':
      return { code: err.code, title: 'No salary on record.', message: err.message };
    case 'NOT_IN_PERIOD':
      return { code: err.code, title: 'Not employed in this period.', message: err.message };
    case 'NOT_FOUND':
      return { code: err.code, title: 'No invoice for this employee.', message: err.message };
    case 'NOT_FINAL':
      return { code: err.code, title: 'This month is not approved yet.', message: err.message };
    case 'BAD_TEMPLATE':
      return { code: err.code, title: 'This file cannot be used as a template.', message: err.message };
    case 'UNKNOWN_PLACEHOLDER':
      return { code: err.code, title: 'The template uses placeholders the system does not know.', message: err.message };
    case 'MISSING_PLACEHOLDER':
      return { code: err.code, title: 'The template is missing a required placeholder.', message: err.message };
    default:
      return { code: err.code, title: fallback, message: err.message };
  }
}

export function ErrorBox({ error, className = '' }: { error: InvoiceErrorView; className?: string }) {
  return (
    <div role="alert" className={`rounded-xl border border-rose-500/30 bg-rose-500/10 px-3.5 py-2.5 text-xs ${className}`}>
      <p className="flex items-start gap-2 font-bold text-rose-300">
        <AlertTriangleIcon className="mt-px h-4 w-4 shrink-0" />
        {error.title}
      </p>
      <p className="mt-0.5 pl-6 text-rose-200/90">{error.message}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The sheet
// ---------------------------------------------------------------------------

const DEFAULT_COMPANY = 'URBANE NETWORK LTD';

function text(value: string | null | undefined): string {
  return value && value.trim() ? value : '—';
}

function Row({ label, value, strong = false }: { label: string; value: string | null | undefined; strong?: boolean }) {
  return (
    <div className={`inv-row${strong ? ' inv-row-strong' : ''}`}>
      <span className="inv-label">{label}</span>
      <span className="inv-value">{text(value)}</span>
    </div>
  );
}

/** One invoice, laid out as the Word template is. Fixed paper colours; prints as is. */
export function InvoiceSheet({ invoice }: { invoice: InvoiceStatement }) {
  const f = invoice.fields;
  const company = f.company_name?.trim() || DEFAULT_COMPANY;
  const contact = [f.company_email, f.company_phone].filter((s) => s && s.trim()).join(' | ');
  const period = f.period_start || f.period_end ? `${text(f.period_start)} - ${text(f.period_end)}` : '—';
  const currency = f.currency || invoice.currency || '';
  const counted = invoice.window?.from && invoice.window?.to
    ? ` Attendance is counted from ${formatDate(invoice.window.from)} to ${formatDate(invoice.window.to)}.`
    : '';

  return (
    <article className="invoice-sheet" aria-label={`Monthly salary statement for ${text(f.employee_name)}`}>
      {invoice.draft && (
        <div className="inv-banner inv-banner-draft" role="note">
          <strong>Provisional.</strong> {invoice.periodStatus === 'IN_REVIEW' ? 'This month is in review' : 'This month is still open'}:
          the figures will change until HR approves the payroll run.{counted}
        </div>
      )}
      {!invoice.integrityOk && (
        <div className="inv-banner inv-banner-danger" role="alert">
          <strong>Integrity check failed.</strong> The published payslip behind this invoice no longer matches the record
          taken when it was approved: it was changed afterwards. Do not rely on this invoice until the change is explained.
        </div>
      )}

      <header className="inv-head">
        <div>
          <div className="inv-company">{company}</div>
          {contact && <div className="inv-contact">{contact}</div>}
          {f.company_address?.trim() && <div className="inv-contact" style={{ whiteSpace: 'pre-line' }}>{f.company_address}</div>}
        </div>
        {invoice.draft && <span className="inv-stamp">Provisional</span>}
      </header>

      <h2 className="inv-title">Monthly Salary Statement</h2>
      <p className="inv-subtitle">A clear monthly summary of salary, attendance and payment details.</p>

      <section className="inv-section">
        <h3 className="inv-section-title">Employee &amp; Payroll Info</h3>
        <div className="inv-grid-2">
          <Row label="Employee Name" value={f.employee_name} />
          <Row label="Payroll Month" value={f.payroll_month} />
          <Row label="Employee ID" value={f.employee_id} />
          <Row label="Pay Period" value={period} />
          <Row label="Position" value={f.job_title} />
          <Row label="Statement Ref" value={f.statement_reference} />
          <Row label="Department" value={f.department} />
          <Row label="Working Arrangement" value={f.working_arrangement} />
        </div>
      </section>

      <section className="inv-section">
        <h3 className="inv-section-title">Salary &amp; Attendance</h3>
        <div className="inv-grid-2" style={{ rowGap: 8 }}>
          <div className="inv-card">
            <h4 className="inv-card-title">Salary Summary</h4>
            <Row label="Monthly Salary" value={f.monthly_salary} />
            <Row label="Bonus / Addition" value={f.addition_amount} />
            {parseFloat(String(f.overtime_amount || '0').replace(/,/g, '')) > 0 && (
              <Row label="Overtime" value={f.overtime_amount} />
            )}
            <Row label="Gross Earnings" value={f.gross_earnings} strong />
            <Row label="Total Deductions" value={f.total_deductions} />
          </div>
          <div className="inv-card">
            <h4 className="inv-card-title">Attendance Summary</h4>
            <Row label="Scheduled Days" value={f.scheduled_days} />
            <Row label="Days Present" value={f.present_days} />
            <Row label="Paid Leave" value={f.paid_leave_days} />
            <Row label="Unpaid Leave" value={f.unpaid_leave_days} />
            <Row label="Sick Leave" value={f.sick_leave_days} />
            <Row label="Unauthorised" value={f.unauthorised_days} />
            <Row label="Hours Worked" value={f.worked_hours} />
            <Row label="Shortfall Hours" value={f.shortfall_hours} />
          </div>
        </div>

        <h4 className="inv-subheading">Deductions</h4>
        <div className="inv-grid-2">
          <Row label="Unpaid Leave" value={f.unpaid_leave_deduction} />
          <Row label="Shortfall" value={f.shortfall_deduction} />
          <Row label="Adjustments" value={f.adjustment_amount} />
          <Row label="Total Deductions" value={f.total_deductions} strong />
        </div>
      </section>

      <section className="inv-section">
        <h3 className="inv-section-title">Net Pay &amp; Bank Details</h3>
        <div className="inv-net">
          <span className="inv-net-label">NET SALARY PAYABLE</span>
          <span className="inv-net-amount">{`${currency} ${text(f.net_salary)}`.trim()}</span>
        </div>
        <div className="inv-grid-2">
          <Row label="Bank Name" value={f.bank_name} />
          <Row label="Account Title" value={f.account_title} />
          <Row label="Account Number" value={f.account_number} />
          <Row label="IBAN" value={f.iban} />
        </div>
      </section>

      <section className="inv-section">
        <h4 className="inv-subheading" style={{ marginTop: 0 }}>Payroll Notes</h4>
        <div className="inv-notes">{text(f.payroll_note)}</div>
      </section>

      <div className="inv-sign">
        <span>Prepared By: <strong>{text(f.prepared_by)}</strong></span>
        <span>Date: <strong>{text(f.generated_date)}</strong></span>
      </div>

      <footer className="inv-footer">
        {company} | Monthly Salary Statement | {text(f.statement_reference)}
      </footer>
    </article>
  );
}

// ---------------------------------------------------------------------------
// The modal
// ---------------------------------------------------------------------------

/**
 * Loads one employee's invoice for one period and shows it over the page,
 * with Download Word / Save PDF / Close. Portalled into <body> so printing can
 * hide everything else.
 */
export function InvoiceModal({
  periodId,
  employeeId,
  employeeName,
  onClose,
}: {
  periodId: string;
  employeeId: string;
  employeeName?: string | null;
  onClose: () => void;
}) {
  const [invoice, setInvoice] = useState<InvoiceStatement | null>(null);
  const [loadError, setLoadError] = useState<InvoiceErrorView | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [downloading, setDownloading] = useState(false);
  const [actionError, setActionError] = useState<InvoiceErrorView | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.payrollInvoice(periodId, employeeId);
        if (cancelled) return;
        setInvoice(res.invoice);
        setLoadError(null);
      } catch (e) {
        if (cancelled) return;
        setInvoice(null);
        setLoadError(describeInvoiceError(e, 'view'));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [periodId, employeeId, reloadTick]);

  // Printing hides every other child of <body> while this is open.
  useEffect(() => {
    document.body.classList.add('invoice-printing');
    return () => document.body.classList.remove('invoice-printing');
  }, []);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const retry = () => {
    setLoadError(null);
    setReloadTick((t) => t + 1);
  };

  const downloadWord = async () => {
    setDownloading(true);
    setActionError(null);
    try {
      saveBlob(await api.payrollInvoiceDocx(periodId, employeeId));
    } catch (e) {
      setActionError(describeInvoiceError(e, 'docx'));
    } finally {
      setDownloading(false);
    }
  };

  const savePdf = () => {
    // The print dialog offers the page title as the PDF's file name.
    const previous = document.title;
    const ref = invoice?.fields.statement_reference?.trim();
    const restore = () => {
      document.title = previous;
      window.removeEventListener('afterprint', restore);
    };
    window.addEventListener('afterprint', restore);
    if (ref) document.title = `${ref} ${invoice?.fields.employee_name ?? ''}`.trim();
    window.print();
  };

  const loading = !invoice && !loadError;
  const name = invoice?.fields.employee_name?.trim() || employeeName || employeeId;
  const statusMeta = invoice ? PERIOD_STATUS_META[invoice.periodStatus] : null;

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="invoice-print-root fixed inset-0 z-[80] overflow-y-auto p-3 animate-fade-in sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={`Invoice for ${name}`}
    >
      {/* The dimmed backdrop is its own layer, so the element that prints carries no filter. */}
      <div aria-hidden="true" className="invoice-no-print fixed inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="invoice-print-frame relative mx-auto flex w-full max-w-[860px] flex-col gap-3">
        <div className="invoice-no-print glass-panel-elevated flex flex-col gap-3 rounded-2xl p-3.5 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <FileTextIcon className="h-4 w-4 shrink-0 text-indigo-400" />
              <h2 className="truncate text-sm font-bold text-white">
                {invoice?.draft ? 'Draft invoice' : 'Invoice'} · {name}
              </h2>
            </div>
            {invoice && (
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                {invoice.draft ? (
                  <Badge tone="warn" size="sm">Provisional draft</Badge>
                ) : (
                  <Badge tone="ok" size="sm">Final</Badge>
                )}
                {statusMeta && <Badge tone={statusMeta.tone} size="sm">{statusMeta.label}</Badge>}
                {!invoice.draft && (invoice.integrityOk ? (
                  <Badge tone="ok" size="sm"><ShieldCheckIcon className="h-3 w-3" /> Integrity verified</Badge>
                ) : (
                  <Badge tone="danger" size="sm"><AlertTriangleIcon className="h-3 w-3" /> Integrity check failed</Badge>
                ))}
              </div>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={downloadWord}
              disabled={!invoice || downloading}
              icon={downloading
                ? <span className="block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                : <DownloadIcon className="h-3.5 w-3.5" />}
            >
              {downloading ? 'Preparing…' : 'Download Word'}
            </Button>
            <Button
              size="sm"
              variant="accent"
              onClick={savePdf}
              disabled={!invoice}
              title="Opens the print dialog: choose Save as PDF"
              icon={<FileTextIcon className="h-3.5 w-3.5" />}
            >
              Save PDF
            </Button>
            <Button size="sm" variant="ghost" onClick={onClose} icon={<XIcon className="h-3.5 w-3.5" />}>
              Close
            </Button>
          </div>
        </div>

        {actionError && (
          <div className="invoice-no-print glass-panel-elevated rounded-2xl p-3">
            <ErrorBox error={actionError} />
          </div>
        )}

        {loading && (
          <div className="invoice-no-print glass-panel-elevated flex h-48 items-center justify-center rounded-2xl">
            <div className="h-7 w-7 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent" />
          </div>
        )}

        {loadError && (
          <div className="invoice-no-print glass-panel-elevated flex flex-col gap-3 rounded-2xl p-4">
            <ErrorBox error={loadError} />
            {loadError.code === 'INVOICE_MISMATCH' && (
              <p className="text-xs text-slate-400">
                The server checks that every line adds up to the net pay before it shows an invoice. This one did not, so
                it was refused rather than shown with wrong figures.
              </p>
            )}
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" onClick={retry} icon={<RefreshIcon className="h-3.5 w-3.5" />}>
                Try again
              </Button>
              <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
            </div>
          </div>
        )}

        {invoice && <InvoiceSheet invoice={invoice} />}

        {invoice && (
          // Sits on the always-dark backdrop, so a fixed light colour rather than a theme token.
          <p className="invoice-no-print pb-2 text-center text-[11px] text-[#e2e8f0]">
            Save PDF opens the print dialog; choose &ldquo;Save as PDF&rdquo;. Only the invoice is printed, on one A4 page.
          </p>
        )}
      </div>
    </div>,
    document.body,
  );
}
