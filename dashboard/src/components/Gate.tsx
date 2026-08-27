'use client';

import { useState } from 'react';

import { api, NotConfiguredError, setKey } from '@/lib/api';
import { Button, Input } from './primitives';

/**
 * The dashboard displays payroll-relevant personal data, so it is behind the
 * admin key. Every endpoint it used to call was unauthenticated.
 */
export function Gate({
  initialError,
  onUnlocked,
}: {
  initialError?: string;
  onUnlocked: () => void;
}) {
  const [value, setValue] = useState('');
  const [error, setError] = useState(initialError ?? '');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const key = value.trim();
    if (!key) return;

    setBusy(true);
    setError('');
    try {
      await api.verifyKey(key);
      setKey(key);
      onUnlocked();
    } catch (err) {
      setError(
        err instanceof NotConfiguredError
          ? err.message
          : 'That admin key was not accepted.',
      );
      setValue('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-screen place-items-center p-6">
      <form
        onSubmit={submit}
        className="flex w-full max-w-md flex-col gap-3 rounded-2xl border border-line bg-surface p-8"
      >
        <h1 className="text-xl font-bold">Office Tracker</h1>
        <p className="mb-2 text-sm text-muted">Administrator access</p>

        <Input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Admin API key"
          autoComplete="current-password"
          autoFocus
        />

        <Button variant="primary" type="submit" disabled={busy} className="py-2.5 text-sm">
          {busy ? 'Checking...' : 'Unlock'}
        </Button>

        <p className="min-h-4 text-xs text-danger">{error}</p>

        <p className="text-[11px] leading-relaxed text-dim">
          Set <code className="rounded bg-raised px-1.5 py-0.5">ADMIN_API_KEY</code> in{' '}
          <code className="rounded bg-raised px-1.5 py-0.5">backend/.env</code>. Generate
          one with <code className="rounded bg-raised px-1.5 py-0.5">npm run genkey</code>.
        </p>
      </form>
    </div>
  );
}
