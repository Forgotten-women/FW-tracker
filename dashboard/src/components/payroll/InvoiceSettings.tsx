'use client';

/**
 * Invoice settings: the Word template every invoice is filled into, the
 * company details printed on it, and a pointer to what employees may see.
 * Lives on the Payroll page, next to the other payroll-wide settings.
 */

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { InvoiceTemplate, InvoiceTemplateResponse, InvoiceTemplateUploadResult } from '@/lib/types';
import { Badge, Button, Input, Panel } from '@/components/primitives';
import {
  CheckCircleIcon,
  ChevronDownIcon,
  DownloadIcon,
  EyeIcon,
  FileTextIcon,
  HistoryIcon,
  InfoIcon,
  LockIcon,
  RefreshIcon,
  UploadIcon,
} from '@/components/icons';
import { formatActor, formatTimestamp } from './format';
import { type InvoiceErrorView, ErrorBox, describeInvoiceError, saveBlob } from './InvoiceView';

const MAX_TEMPLATE_BYTES = 4 * 1024 * 1024;

function Spinner() {
  return (
    <div className="flex h-24 items-center justify-center">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent" />
    </div>
  );
}

function Block({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-white/10 bg-white/3 p-4">
      <h3 className="text-sm font-bold text-white">{title}</h3>
      {subtitle && <p className="mt-0.5 text-xs text-slate-400">{subtitle}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function FieldChips({ fields, tone }: { fields: string[]; tone: 'accent' | 'dim' }) {
  if (fields.length === 0) return <p className="text-[11px] text-slate-500">None.</p>;
  return (
    <ul className="flex flex-wrap gap-1">
      {fields.map((f) => (
        <li key={f}>
          <Badge tone={tone} size="sm" className="font-mono">{`{{${f}}}`}</Badge>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Template: active version, history, upload
// ---------------------------------------------------------------------------

function TemplateSection() {
  const [data, setData] = useState<InvoiceTemplateResponse | null>(null);
  const [loadError, setLoadError] = useState<InvoiceErrorView | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<InvoiceErrorView | null>(null);

  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [inputKey, setInputKey] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<InvoiceErrorView | null>(null);
  const [uploaded, setUploaded] = useState<InvoiceTemplateUploadResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.invoiceTemplate();
        if (cancelled) return;
        setData(res);
        setLoadError(null);
      } catch (e) {
        if (!cancelled) setLoadError(describeInvoiceError(e, 'template'));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadTick]);

  const reload = () => {
    setLoadError(null);
    setReloadTick((t) => t + 1);
  };

  const download = async (t: InvoiceTemplate) => {
    setDownloadingId(t.id);
    setDownloadError(null);
    try {
      saveBlob(await api.invoiceTemplateFile(t.id));
    } catch (e) {
      setDownloadError(describeInvoiceError(e, 'template'));
    } finally {
      setDownloadingId(null);
    }
  };

  const pick = (f: File | null) => {
    setUploaded(null);
    setUploadError(null);
    if (!f) {
      setFile(null);
      return;
    }
    if (!/\.docx$/i.test(f.name)) {
      setFile(null);
      setUploadError({ code: 'BAD_TEMPLATE', title: 'This file cannot be used as a template.', message: 'Choose a Word document saved as .docx.' });
      return;
    }
    if (f.size > MAX_TEMPLATE_BYTES) {
      setFile(null);
      setUploadError({ code: 'BAD_TEMPLATE', title: 'This file is too large.', message: 'The template must be under 4 MB.' });
      return;
    }
    setFile(f);
  };

  const submit = async () => {
    if (!file) return;
    setUploading(true);
    setUploadError(null);
    setUploaded(null);
    try {
      const res = await api.uploadInvoiceTemplate(file, name);
      setUploaded({ template: res.template, report: res.report });
      setFile(null);
      setName('');
      setInputKey((k) => k + 1);
      reload();
    } catch (e) {
      setUploadError(describeInvoiceError(e, 'upload'));
    } finally {
      setUploading(false);
    }
  };

  const active = data?.active ?? null;
  const versions = data?.versions ?? [];

  const downloadButton = (t: InvoiceTemplate) => (
    <Button
      size="sm"
      variant="secondary"
      onClick={() => download(t)}
      disabled={downloadingId !== null}
      icon={downloadingId === t.id
        ? <span className="block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
        : <DownloadIcon className="h-3.5 w-3.5" />}
    >
      Download
    </Button>
  );

  return (
    <>
      <Block
        title="Active template"
        subtitle="The Word document every invoice is filled into. Download it, edit it in Word, and upload it again as a new version."
      >
        {loadError ? (
          <div className="flex flex-col gap-2">
            <ErrorBox error={loadError} />
            <div>
              <Button size="sm" variant="secondary" onClick={reload} icon={<RefreshIcon className="h-3.5 w-3.5" />}>
                Try again
              </Button>
            </div>
          </div>
        ) : !data ? (
          <Spinner />
        ) : !active ? (
          <div className="rounded-xl border border-dashed border-amber-500/30 bg-amber-500/5 px-3.5 py-3 text-xs text-amber-300">
            No template has been uploaded yet. Invoices can still be viewed on screen and saved as PDF, but Word downloads are
            refused until one is uploaded below.
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="truncate text-sm font-semibold text-white">{active.name}</span>
                  <Badge tone="accent" size="sm">Version {active.version}</Badge>
                  <Badge tone="ok" size="sm">Active</Badge>
                </div>
                <p className="mt-1 text-[11px] text-slate-400">
                  Uploaded {formatTimestamp(active.uploadedAt)} by {formatActor(active.uploadedBy)}
                </p>
                <p className="mt-0.5 truncate font-mono text-[10px] text-slate-500" title={active.sha256}>
                  SHA-256 {active.sha256.slice(0, 16)}…
                </p>
              </div>
              <div className="shrink-0">{downloadButton(active)}</div>
            </div>
            <div>
              <p className="mb-1.5 text-[11px] font-semibold text-slate-400">
                Placeholders it prints ({active.placeholders.length})
              </p>
              <FieldChips fields={active.placeholders} tone="accent" />
            </div>
            <div>
              <p className="mb-1.5 text-[11px] font-semibold text-slate-400">
                Available but not used ({active.unused.length})
              </p>
              <FieldChips fields={active.unused} tone="dim" />
            </div>
          </div>
        )}
        {downloadError && <ErrorBox error={downloadError} className="mt-3" />}
      </Block>

      <Block
        title="Upload a new version"
        subtitle="A Word (.docx) file up to 4 MB. It becomes the active template straight away; invoices already published keep the version they were issued with."
      >
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex min-w-0 flex-col gap-1">
              <span className="text-[11px] font-semibold text-slate-400">Template file (.docx)</span>
              <input
                key={inputKey}
                type="file"
                accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                onChange={(ev) => pick(ev.target.files?.[0] ?? null)}
                className="w-full min-w-0 rounded-xl border border-white/10 bg-slate-900/70 px-3 py-2 text-xs text-slate-300 file:mr-3 file:cursor-pointer file:rounded-lg file:border-0 file:bg-indigo-500/15 file:px-2.5 file:py-1 file:text-xs file:font-semibold file:text-indigo-300"
              />
            </label>
            <label className="flex min-w-0 flex-col gap-1">
              <span className="text-[11px] font-semibold text-slate-400">Name (optional)</span>
              <Input
                value={name}
                onChange={(ev) => setName(ev.target.value)}
                placeholder="Defaults to the file name"
                maxLength={120}
                className="py-2"
              />
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="accent"
              onClick={submit}
              disabled={!file || uploading}
              icon={uploading
                ? <span className="block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                : <UploadIcon className="h-4 w-4" />}
            >
              {uploading ? 'Checking and uploading…' : 'Upload template'}
            </Button>
            {file && <span className="truncate text-[11px] text-slate-400">{file.name} · {(file.size / 1024).toFixed(0)} KB</span>}
          </div>

          {uploadError && <ErrorBox error={uploadError} />}

          {uploaded && (
            <div role="status" className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-3 text-xs">
              <p className="flex items-center gap-2 font-bold text-emerald-300">
                <CheckCircleIcon className="h-4 w-4 shrink-0" />
                Version {uploaded.template.version} uploaded and now active.
              </p>
              <p className="mt-1 text-emerald-200/90">
                It prints {uploaded.report.used.length} placeholder{uploaded.report.used.length === 1 ? '' : 's'}.
                {uploaded.report.unused.length > 0
                  ? ` ${uploaded.report.unused.length} available field${uploaded.report.unused.length === 1 ? ' is' : 's are'} not used:`
                  : ' Every available field is used.'}
              </p>
              {uploaded.report.unused.length > 0 && (
                <div className="mt-2">
                  <FieldChips fields={uploaded.report.unused} tone="dim" />
                </div>
              )}
            </div>
          )}

          {data && data.fields.length > 0 && (
            <details className="rounded-xl border border-white/8 bg-white/3 px-3.5 py-2.5 text-xs text-slate-400">
              <summary className="cursor-pointer font-semibold text-slate-300">How to write a template</summary>
              <p className="mt-2">
                Type a placeholder in double braces where a value should appear, for example{' '}
                <span className="font-mono text-slate-200">{'{{employee_name}}'}</span>. A template must include{' '}
                {data.requiredFields.map((f, i) => (
                  <span key={f}>
                    <span className="font-mono text-slate-200">{`{{${f}}}`}</span>
                    {i < data.requiredFields.length - 1 ? ', ' : ''}
                  </span>
                ))}
                . Any placeholder not in this list is refused, so a typo cannot print a blank:
              </p>
              <div className="mt-2">
                <FieldChips fields={data.fields} tone="dim" />
              </div>
            </details>
          )}
        </div>
      </Block>

      {data && versions.length > 0 && (
        <Block title="Version history" subtitle="Every template ever uploaded. Each invoice keeps the version it was published with.">
          <ul className="divide-y divide-white/5 overflow-hidden rounded-xl border border-white/8">
            {versions.map((t) => (
              <li key={t.id} className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <HistoryIcon className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                    <span className="text-xs font-semibold text-slate-200">v{t.version}</span>
                    <span className="truncate text-xs text-slate-300">{t.name}</span>
                    {t.active && <Badge tone="ok" size="sm">Active</Badge>}
                  </div>
                  <p className="mt-0.5 text-[11px] text-slate-500">
                    {formatTimestamp(t.uploadedAt)} · {formatActor(t.uploadedBy)} · {t.placeholders.length} placeholder
                    {t.placeholders.length === 1 ? '' : 's'}
                  </p>
                </div>
                <div className="shrink-0">{downloadButton(t)}</div>
              </li>
            ))}
          </ul>
        </Block>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Company details (org settings)
// ---------------------------------------------------------------------------

const COMPANY_FIELDS = [
  { key: 'invoice_company_name', label: 'Company name', placeholder: 'URBANE NETWORK LTD', help: 'Printed at the top of every invoice and in its footer.' },
  { key: 'invoice_company_email', label: 'Company email', placeholder: 'e.g. payroll@company.com', help: '' },
  { key: 'invoice_company_phone', label: 'Company phone', placeholder: 'e.g. +44 20 0000 0000', help: '' },
  { key: 'invoice_company_address', label: 'Company address', placeholder: 'Street, city, postcode', help: 'Line breaks are kept.' },
  { key: 'invoice_reference_prefix', label: 'Reference prefix', placeholder: 'INV', help: '' },
  { key: 'invoice_prepared_by', label: 'Prepared by', placeholder: 'HR Department', help: 'Printed on drafts, and on approved invoices whose run was approved with the admin key. A run approved by a named HR user prints that person\'s name.' },
] as const;

type CompanyKey = (typeof COMPANY_FIELDS)[number]['key'];
type CompanyValues = Record<CompanyKey, string>;

const EMPTY_VALUES = Object.fromEntries(COMPANY_FIELDS.map((f) => [f.key, ''])) as CompanyValues;
const PREFIX_OK = /^[A-Za-z0-9]{0,10}$/;

function CompanySection() {
  const [saved, setSaved] = useState<CompanyValues | null>(null);
  const [values, setValues] = useState<CompanyValues>(EMPTY_VALUES);
  const [loadError, setLoadError] = useState('');
  const [reloadTick, setReloadTick] = useState(0);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.getSettings();
        if (cancelled) return;
        const s = res.settings ?? {};
        const next = Object.fromEntries(COMPANY_FIELDS.map((f) => [f.key, s[f.key] ?? ''])) as CompanyValues;
        setSaved(next);
        setValues(next);
        setLoadError('');
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : 'Could not load the company details.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadTick]);

  const prefix = values.invoice_reference_prefix.trim();
  const prefixValid = PREFIX_OK.test(prefix);
  const changed = saved ? COMPANY_FIELDS.filter((f) => values[f.key].trim() !== saved[f.key].trim()) : [];

  const save = async () => {
    if (!saved || changed.length === 0 || !prefixValid) return;
    setSaving(true);
    setNotice(null);
    const done: CompanyKey[] = [];
    try {
      for (const f of changed) {
        await api.updateSetting(f.key, values[f.key].trim());
        done.push(f.key);
      }
      setSaved({ ...saved, ...Object.fromEntries(done.map((k) => [k, values[k].trim()])) });
      setNotice({ tone: 'ok', text: 'Saved. New and re-opened invoices use these details; approved invoices already downloaded are unchanged.' });
    } catch (e) {
      if (done.length) setSaved({ ...saved, ...Object.fromEntries(done.map((k) => [k, values[k].trim()])) });
      setNotice({ tone: 'danger', text: `${e instanceof Error ? e.message : 'Could not save.'}${done.length ? ` ${done.length} of ${changed.length} change(s) were saved.` : ''}` });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Block title="Company details" subtitle="Printed on every invoice. Leave a field empty to print nothing there.">
      {loadError ? (
        <div className="flex flex-col gap-2">
          <ErrorBox error={{ code: null, title: 'The company details could not be loaded.', message: loadError }} />
          <div>
            <Button size="sm" variant="secondary" onClick={() => { setLoadError(''); setReloadTick((t) => t + 1); }} icon={<RefreshIcon className="h-3.5 w-3.5" />}>
              Try again
            </Button>
          </div>
        </div>
      ) : !saved ? (
        <Spinner />
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(ev) => {
            ev.preventDefault();
            save();
          }}
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {COMPANY_FIELDS.map((f) => {
              const isPrefix = f.key === 'invoice_reference_prefix';
              const isAddress = f.key === 'invoice_company_address';
              return (
                <label key={f.key} className={`flex min-w-0 flex-col gap-1 ${isAddress ? 'sm:col-span-2' : ''}`}>
                  <span className="text-[11px] font-semibold text-slate-400">{f.label}</span>
                  {isAddress ? (
                    <textarea
                      rows={2}
                      value={values[f.key]}
                      onChange={(ev) => setValues((v) => ({ ...v, [f.key]: ev.target.value }))}
                      placeholder={f.placeholder}
                      maxLength={500}
                      className="w-full resize-y rounded-xl border border-white/10 bg-slate-900/70 px-3.5 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-indigo-500/70 focus:outline-none focus:ring-4 focus:ring-indigo-500/15"
                    />
                  ) : (
                    <Input
                      value={values[f.key]}
                      onChange={(ev) => setValues((v) => ({ ...v, [f.key]: ev.target.value }))}
                      placeholder={f.placeholder}
                      maxLength={isPrefix ? 10 : 200}
                      type={f.key === 'invoice_company_email' ? 'email' : 'text'}
                      aria-invalid={isPrefix && !prefixValid}
                      className={`py-2 ${isPrefix && !prefixValid ? 'border-rose-500/60' : ''}`}
                    />
                  )}
                  {isPrefix ? (
                    <span className={`text-[11px] ${prefixValid ? 'text-slate-500' : 'text-rose-400'}`}>
                      {prefixValid
                        ? <>Letters and digits, up to 10. References read <span className="font-mono text-slate-300">{prefix || 'INV'}-YYYYMM-&lt;employee ID&gt;</span>; drafts start with DRAFT-.</>
                        : 'Use letters and digits only (no spaces or symbols), up to 10.'}
                    </span>
                  ) : f.help ? (
                    <span className="text-[11px] text-slate-500">{f.help}</span>
                  ) : null}
                </label>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" variant="accent" disabled={saving || changed.length === 0 || !prefixValid}>
              {saving ? 'Saving…' : changed.length > 0 ? `Save ${changed.length} change${changed.length === 1 ? '' : 's'}` : 'Saved'}
            </Button>
            {changed.length > 0 && !saving && (
              <Button type="button" variant="ghost" onClick={() => { setValues(saved); setNotice(null); }}>
                Discard
              </Button>
            )}
          </div>
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
        </form>
      )}
    </Block>
  );
}

// ---------------------------------------------------------------------------
// Employee visibility (the switches live in the bar at the top of Payroll)
// ---------------------------------------------------------------------------

function VisibilitySummary({
  salaryVisible,
  estimateVisible,
  onShowVisibility,
}: {
  salaryVisible: boolean | null;
  estimateVisible: boolean | null;
  onShowVisibility: () => void;
}) {
  const state = (on: boolean | null) =>
    on === null ? <Badge tone="dim" size="sm">Unknown</Badge>
      : on ? <Badge tone="ok" size="sm"><EyeIcon className="h-3 w-3" /> On</Badge>
        : <Badge tone="muted" size="sm"><LockIcon className="h-3 w-3" /> Off</Badge>;
  return (
    <Block
      title="What employees see"
      subtitle="Both switches are in the Employee Mobile Salary Visibility bar at the top of the Payroll page."
    >
      <ul className="flex flex-col gap-2 text-xs">
        <li className="flex items-start justify-between gap-3">
          <span className="text-slate-300">
            <span className="font-semibold text-white">Approved invoices on the phone.</span> Employees can open their own
            invoice for every month HR has approved.
          </span>
          <span className="shrink-0">{state(salaryVisible)}</span>
        </li>
        <li className="flex items-start justify-between gap-3">
          <span className="text-slate-300">
            <span className="font-semibold text-white">This month&apos;s draft too.</span> Employees also see a provisional
            invoice for the month in progress. Needs the first switch on.
          </span>
          <span className="shrink-0">{state(estimateVisible)}</span>
        </li>
      </ul>
      <div className="mt-3">
        <Button size="sm" variant="secondary" onClick={onShowVisibility}>
          Change these at the top of the page
        </Button>
      </div>
    </Block>
  );
}

// ---------------------------------------------------------------------------
// The section
// ---------------------------------------------------------------------------

export function InvoiceSettingsPanel({
  open,
  onToggle,
  salaryVisible,
  estimateVisible,
  onShowVisibility,
}: {
  open: boolean;
  onToggle: () => void;
  salaryVisible: boolean | null;
  estimateVisible: boolean | null;
  onShowVisibility: () => void;
}) {
  return (
    <div id="invoice-settings" className="scroll-mt-28">
      <Panel
        title="Invoice settings"
        subtitle="The Word template and company details printed on every monthly invoice"
        icon={<FileTextIcon className="h-5 w-5" />}
        actions={
          <Button
            size="sm"
            variant="secondary"
            onClick={onToggle}
            aria-expanded={open}
            aria-controls="invoice-settings-body"
            icon={<ChevronDownIcon className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />}
          >
            {open ? 'Hide' : 'Show'}
          </Button>
        }
      >
        {open ? (
          <div id="invoice-settings-body" className="flex flex-col gap-4">
            <TemplateSection />
            <CompanySection />
            <VisibilitySummary
              salaryVisible={salaryVisible}
              estimateVisible={estimateVisible}
              onShowVisibility={onShowVisibility}
            />
          </div>
        ) : (
          <p className="flex items-start gap-2 text-xs text-slate-400">
            <InfoIcon className="mt-px h-3.5 w-3.5 shrink-0" />
            Upload the invoice template, check which version is active, and set the company details every invoice prints.
          </p>
        )}
      </Panel>
    </div>
  );
}
