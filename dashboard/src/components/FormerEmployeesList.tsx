'use client';

// Former Employees (HR update 2026-11-17): employees whose employment has
// ended, kept apart from the live workforce. Searchable by name, Employee ID,
// role, start date and final date; opening one shows their full history.

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { FormerEmployee } from '@/lib/types';
import { Badge, Empty, Input } from '@/components/primitives';
import { SearchIcon } from '@/components/icons';

export function FormerEmployeesList({ onOpen }: { onOpen: (e: FormerEmployee) => void }) {
  const [rows, setRows] = useState<FormerEmployee[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    let alive = true;
    api.formerEmployees()
      .then((r) => { if (alive) setRows(r.employees); })
      .catch((err) => { if (alive) setError(err instanceof Error ? err.message : 'Could not load former employees.'); });
    return () => { alive = false; };
  }, []);

  const term = q.trim().toLowerCase();
  const shown = (rows ?? []).filter((r) => !term || [r.employeeName, r.employeeNumber, r.role, r.employmentStartDate, r.finalEmploymentDate]
    .some((v) => v && String(v).toLowerCase().includes(term)));

  return (
    <div className="glass-panel rounded-2xl p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold text-white">Former Employees <span className="font-mono text-slate-400">— {rows?.length ?? '…'}</span></h3>
          <p className="text-[11px] text-slate-400">Not part of the live workforce or any attendance figure. Full history kept for HR reference.</p>
        </div>
        <div className="w-full sm:w-72">
          <Input icon={<SearchIcon className="h-4 w-4" />} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, ID, role, start or final date…" className="text-xs py-1.5" />
        </div>
      </div>
      {error && <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{error}</div>}
      {rows && shown.length === 0 ? (
        <Empty title={rows.length ? 'No former employee matches that search' : 'No former employees'} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-white/10 text-slate-400">
                <th className="px-3 py-2 font-semibold">Employee</th>
                <th className="px-3 py-2 font-semibold">Role</th>
                <th className="px-3 py-2 font-semibold">Employment start</th>
                <th className="px-3 py-2 font-semibold">Final employment date</th>
                <th className="px-3 py-2 font-semibold">Status</th>
                <th className="px-3 py-2 font-semibold">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {shown.map((r) => (
                <tr key={r.employeeId} onClick={() => onOpen(r)} className="cursor-pointer hover:bg-white/5" title="Open the employee's history">
                  <td className="px-3 py-2.5">
                    <div className="font-semibold text-slate-100">{r.employeeName}</div>
                    {r.employeeNumber && <span className="font-mono text-[10px] text-indigo-300">{r.employeeNumber}</span>}
                  </td>
                  <td className="px-3 py-2.5 text-slate-300">{r.role || '—'}</td>
                  <td className="px-3 py-2.5 font-mono text-slate-300">{r.employmentStartDate || '—'}</td>
                  <td className="px-3 py-2.5 font-mono text-slate-100">{r.finalEmploymentDate || '—'}</td>
                  <td className="px-3 py-2.5"><Badge tone="muted" size="sm">Former Employee</Badge></td>
                  <td className="px-3 py-2.5 text-slate-400">{r.updatedAt || '—'}{r.updatedBy ? ` · ${r.updatedBy}` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
