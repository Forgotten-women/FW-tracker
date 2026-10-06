import type { DayView } from './types';

/** "7h 16m" from minutes (the same style the backend's formatMinutes uses). */
export function formatHM(minutes: number | null | undefined): string {
  const m = Math.max(0, Math.round(minutes ?? 0));
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Target, break allowance and remaining as one short line, from the shared day view. */
export function targetLine(day: DayView): string {
  return `Target ${formatHM(day.targetMinutes)} (break up to ${day.permittedBreakMinutes}m counts)`;
}
