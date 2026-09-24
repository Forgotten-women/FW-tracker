// HR's explicit decisions on the lines that need one, before they are sent
// with approve-run. Nothing here talks to the server.

import type { PayrollReviewLine, PayrollRunDecision } from '@/lib/types';
import { money, needsDecision, standingAmount } from './format';

/** CHANGED is "approve, at a different amount". */
export type LineChoice = 'APPROVED' | 'REJECTED' | 'CHANGED';

export interface LineDecision {
  choice: LineChoice | null;
  /** CHANGED only, as typed: a magnitude when the calculated figure has a sign. */
  amount: string;
  note: string;
}

export type DecisionMap = Record<string, LineDecision>;

export const EMPTY_DECISION: LineDecision = { choice: null, amount: '', note: '' };

/** A line that needs a decision, wherever it came from. */
export interface DecidableLine {
  id: string;
  employeeId: string;
  employeeName: string;
  type: string;
  calculatedAmount: number;
  calculatedDays: number;
  explanation: string | null;
  reviewReasons: string[];
  /** The employee's salary currency; null when they have no salary on record. */
  currency: string | null;
}

/**
 * -1 for a deduction, 1 for an addition, 0 for a zero figure. A changed amount
 * is typed as a positive number and given the calculated line's sign, so
 * "300" on a deduction can never turn it into a payment.
 */
export function amountSign(calculated: number): -1 | 0 | 1 {
  return calculated < 0 ? -1 : calculated > 0 ? 1 : 0;
}

/** The approved amount a CHANGED decision stands for, or null if the input is not usable. */
export function parseChangedAmount(calculated: number, input: string): number | null {
  const t = input.trim().replace(/,/g, '');
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  const sign = amountSign(calculated);
  if (sign === 0) return money(n);
  if (n < 0) return null;
  return money(sign * n);
}

/** What is still missing before this decision can be sent, or null when it is complete. */
export function decisionProblem(calculated: number, d: LineDecision | undefined): string | null {
  if (!d || !d.choice) return 'Choose approve, reject or a different amount.';
  if (d.choice === 'CHANGED' && parseChangedAmount(calculated, d.amount) === null) {
    return amountSign(calculated) === 0
      ? 'Enter the amount to approve.'
      : 'Enter the amount to approve, as a positive number.';
  }
  if ((d.choice === 'REJECTED' || d.choice === 'CHANGED') && !d.note.trim()) {
    return d.choice === 'REJECTED' ? 'Add a note saying why it is rejected.' : 'Add a note saying why the amount changed.';
  }
  return null;
}

/** The amount a line would stand at if the run were approved with this decision. */
export function projectedAmount(line: PayrollReviewLine, d: LineDecision | undefined): number {
  if (!needsDecision(line) || !d || !d.choice) return standingAmount(line);
  if (d.choice === 'REJECTED') return 0;
  if (d.choice === 'CHANGED') return parseChangedAmount(line.calculatedAmount, d.amount) ?? line.calculatedAmount;
  return line.calculatedAmount;
}

/** The body entry approve-run takes for one decided line. */
export function toRunDecision(line: DecidableLine, d: LineDecision): PayrollRunDecision {
  const out: PayrollRunDecision = {
    adjustmentId: line.id,
    decision: d.choice === 'REJECTED' ? 'REJECTED' : 'APPROVED',
  };
  if (d.choice === 'CHANGED') {
    const amount = parseChangedAmount(line.calculatedAmount, d.amount);
    if (amount !== null) out.approvedAmount = amount;
  }
  const note = d.note.trim();
  // Left out, the backend records "Decided in the payroll run: <run note>".
  if (note) out.notes = note;
  return out;
}
