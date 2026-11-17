'use client';

// In the employee drawer: the employee's employment status, and the action
// that fits it - "Change employment status → Former Employee", or "Rehire"
// for a former employee.

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { AdminEmployee } from '@/lib/types';
import { Badge } from '@/components/primitives';
import { EmploymentStatusModal, type EmploymentStatusMode } from './EmploymentStatusModal';

export function EmploymentStatusControl({ employeeId, employeeName, onChanged }: { employeeId: string; employeeName: string; onChanged?: () => void }) {
  const [emp, setEmp] = useState<AdminEmployee | null>(null);
  const [mode, setMode] = useState<EmploymentStatusMode | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let alive = true;
    api.employees()
      .then((r) => { if (alive) setEmp(r.employees.find((e) => e.id === employeeId) ?? null); })
      .catch(() => {});
    return () => { alive = false; };
  }, [employeeId, version]);

  if (!emp) return null;
  const former = emp.employmentStatus === 'Former employee' && !emp.active;

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
      <span className="text-slate-400">Employment Status:</span>
      <Badge tone={former ? 'danger' : 'ok'} size="sm">{former ? 'Former Employee' : emp.employmentStatus || 'Active'}</Badge>
      {emp.finalEmploymentDate && (
        <span className="text-slate-400">
          {former ? 'Final employment date' : 'Leaving on'} <strong className="font-mono text-slate-200">{emp.finalEmploymentDate}</strong>
          {emp.formerPending && ' (moves to Former Employees the day after)'}
        </span>
      )}
      {former ? (
        <button type="button" onClick={() => { setDone(null); setMode('REHIRE'); }} className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 font-semibold text-emerald-300 hover:bg-emerald-500/20">
          Rehire…
        </button>
      ) : !emp.formerPending && (
        <button type="button" onClick={() => { setDone(null); setMode('FORMER'); }} className="rounded-lg border border-white/10 bg-white/5 px-2 py-0.5 font-semibold text-slate-300 hover:text-white hover:bg-white/10">
          Change employment status → Former Employee
        </button>
      )}
      {done && <span className="text-emerald-300">{done}</span>}
      {mode && (
        <EmploymentStatusModal
          employeeId={employeeId}
          employeeName={employeeName}
          employeeNumber={emp.employeeNumber}
          startDate={emp.startDate}
          mode={mode}
          onClose={() => setMode(null)}
          onDone={(message) => { setMode(null); setDone(message); setVersion((v) => v + 1); onChanged?.(); }}
        />
      )}
    </div>
  );
}
