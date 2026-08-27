'use client';

import { useCallback, useState, useSyncExternalStore } from 'react';

import { Gate } from '@/components/Gate';
import {
  ActivityFeed,
  AttendanceTable,
  CodeModal,
  Header,
  PresenceGrid,
  Stats,
  TeamPanel,
  WarningBar,
} from '@/components/panels';
import { useDashboard } from '@/hooks/useDashboard';
import { api, clearKey, getKey, notifyKeyChanged, subscribeToKey } from '@/lib/api';
import type { AdminEmployee, EnrollmentCode } from '@/lib/types';

export default function DashboardPage() {
  const [gateError, setGateError] = useState<string>('');
  const [pairing, setPairing] = useState<(EnrollmentCode & { name: string }) | null>(null);

  // The admin key lives in sessionStorage, which is an external store rather
  // than React state. Subscribing to it directly avoids the extra render pass
  // that reading it in an effect and calling setState caused, and keeps the
  // server snapshot honest: during SSR there is no sessionStorage, so nothing
  // is unlocked.
  const unlocked = useSyncExternalStore(subscribeToKey, () => Boolean(getKey()), () => false);

  const lock = useCallback((message: string) => {
    clearKey();
    setGateError(message);
    notifyKeyChanged();
  }, []);

  const { summary, employees, connection, error, refresh } = useDashboard(
    unlocked,
    lock,
  );

  const addEmployee = async (name: string, role: string) => {
    await api.createEmployee(name, role);
    await refresh();
  };

  const pairDevice = async (employee: AdminEmployee) => {
    const result = await api.enrollmentCode(employee.id);
    setPairing({ ...result, name: employee.name });
    await refresh();
  };

  const exportCsv = async (from: string, to: string) => {
    const blob = await api.exportCsv(from, to);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `attendance-${from}_${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (unlocked === undefined) {
    return <div className="grid min-h-screen place-items-center text-sm text-dim">Loading…</div>;
  }

  if (!unlocked) {
    return (
      <Gate
        initialError={gateError}
        onUnlocked={() => {
          setGateError('');
          // Gate has already written the key via setKey(), which notifies the
          // store subscribers - so unlocked flips on its own.
          notifyKeyChanged();
        }}
      />
    );
  }

  return (
    <div className="min-h-screen">
      <Header summary={summary} connection={connection} onLock={() => lock('')} />

      {summary && <WarningBar summary={summary} />}

      {error && (
        <div className="mx-6 mb-4 rounded-lg border border-danger bg-danger-dim px-4 py-3 text-xs">
          {error} — showing the last successful load.
        </div>
      )}

      <main className="px-6 pb-10">
        {!summary ? (
          <p className="py-10 text-center text-sm text-dim">Loading dashboard…</p>
        ) : (
          <>
            <Stats summary={summary} />

            <div className="grid grid-cols-1 gap-5 xl:grid-cols-[2fr_1fr]">
              <div className="flex min-w-0 flex-col gap-5">
                <PresenceGrid summary={summary} />
                <AttendanceTable
                  rows={summary.todayAttendance}
                  dateKey={summary.currentDateKey}
                  onExport={exportCsv}
                />
              </div>

              <div className="flex min-w-0 flex-col gap-5">
                <TeamPanel
                  employees={employees}
                  onAdd={addEmployee}
                  onPair={pairDevice}
                />
                <ActivityFeed movements={summary.recentMovements} />
              </div>
            </div>
          </>
        )}
      </main>

      {pairing && (
        <CodeModal
          code={pairing.code}
          employeeName={pairing.name}
          expires={pairing.expiresAtDisplay}
          onClose={() => setPairing(null)}
        />
      )}
    </div>
  );
}
