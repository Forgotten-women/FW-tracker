'use client';

import { useState } from 'react';
import { api, NotConfiguredError, setKey } from '@/lib/api';
import { Button, Input } from './primitives';

/**
 * Modernized Enterprise Security Gate for HR Dashboard.
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
  const [showPassword, setShowPassword] = useState(false);

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
          : 'Access denied. The provided Administrator Key is invalid.',
      );
      setValue('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative grid min-h-screen place-items-center overflow-hidden bg-[#07090E] p-6 text-slate-100 selection:bg-indigo-500 selection:text-white">
      {/* Ambient background glows */}
      <div className="pointer-events-none absolute -top-40 left-1/2 h-96 w-96 -translate-x-1/2 rounded-full bg-indigo-600/20 blur-[120px]" />
      <div className="pointer-events-none absolute -bottom-40 left-1/3 h-96 w-96 -translate-x-1/2 rounded-full bg-emerald-600/10 blur-[120px]" />

      <div className="relative w-full max-w-md">
        {/* Glow halo */}
        <div className="absolute -inset-1 rounded-3xl bg-gradient-to-r from-indigo-500/30 via-emerald-500/20 to-indigo-500/30 opacity-70 blur-xl transition-all duration-1000 group-hover:opacity-100" />

        <div className="relative rounded-3xl border border-white/10 bg-slate-900/85 p-8 shadow-2xl backdrop-blur-2xl sm:p-10">
          {/* Header Brand */}
          <div className="flex flex-col items-center text-center">
            <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-indigo-700 text-white shadow-xl shadow-indigo-500/30 border border-indigo-400/30">
              <svg className="h-7 w-7" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
                />
              </svg>
            </div>
            <h1 className="text-2xl font-extrabold tracking-tight text-white">
              Office Tracker
            </h1>
            <p className="mt-1 text-xs font-medium text-slate-400">
              HR Administration & Workforce Management
            </p>
          </div>

          {/* Form */}
          <form onSubmit={submit} className="mt-8 flex flex-col gap-4">
            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400">
                Administrator API Key
              </label>
              <div className="relative flex items-center">
                <Input
                  type={showPassword ? 'text' : 'password'}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder="Enter secret admin key…"
                  autoComplete="current-password"
                  autoFocus
                  required
                  className="pr-10 font-mono text-xs"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 text-slate-400 hover:text-slate-200 transition"
                  title={showPassword ? 'Hide key' : 'Show key'}
                >
                  {showPassword ? (
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l18 18" />
                    </svg>
                  ) : (
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                    </svg>
                  )}
                </button>
              </div>
            </div>

            {error && (
              <div className="flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3.5 py-2.5 text-xs text-rose-300">
                <svg className="h-4 w-4 shrink-0 text-rose-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span>{error}</span>
              </div>
            )}

            <Button
              variant="accent"
              type="submit"
              disabled={busy || !value.trim()}
              size="lg"
              className="mt-2 w-full"
            >
              {busy ? (
                <div className="flex items-center gap-2">
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  <span>Verifying Authorization…</span>
                </div>
              ) : (
                <div className="flex items-center justify-center gap-2">
                  <span>Unlock HR Dashboard</span>
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
                  </svg>
                </div>
              )}
            </Button>

            <div className="mt-4 rounded-xl border border-white/5 bg-slate-950/50 p-3.5 text-center text-[11px] leading-relaxed text-slate-400">
              Authorized personnel only. Sessions are bound to this browser and verified against the backend RBAC service.
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
