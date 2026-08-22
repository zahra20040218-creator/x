import type { IqdAmount } from '../money/iqd.js';

/** CLAUDE.md §6.2 - the four permitted account types, no others. */
export const LEDGER_ACCOUNT_TYPES = [
  'DRIVER_WALLET',
  'PLATFORM_REVENUE',
  'DRIVER_CASH_HELD',
  'MANUAL_ADJUSTMENT',
] as const;

export type LedgerAccountType = (typeof LEDGER_ACCOUNT_TYPES)[number];

export type LedgerDirection = 'DEBIT' | 'CREDIT';

/**
 * One side of a double-entry transaction.
 *
 * The amount is always POSITIVE and the sign lives in `direction`. Allowing a
 * negative amount would give two ways to express the same movement, and
 * "entries sum to zero" would stop being a single unambiguous check.
 */
export interface LedgerCommand {
  accountType: LedgerAccountType;
  /** NULL only for PLATFORM_REVENUE, which has no owning user. */
  accountId: string | null;
  direction: LedgerDirection;
  amountIqd: IqdAmount;
  description: string;
}

export interface LedgerEntry extends LedgerCommand {
  id: string;
  transactionId: string;
  rideId: string | null;
  createdAt: Date;
}

/** Signed value of one entry: CREDIT is positive, DEBIT is negative. */
export function signedValue(command: LedgerCommand): number {
  return command.direction === 'CREDIT' ? command.amountIqd : -command.amountIqd;
}

/** The double-entry invariant, as a function. */
export function netOf(commands: readonly LedgerCommand[]): number {
  return commands.reduce((sum, c) => sum + signedValue(c), 0);
}

export function isBalanced(commands: readonly LedgerCommand[]): boolean {
  return commands.length >= 2 && netOf(commands) === 0;
}

export class UnbalancedLedgerError extends Error {
  constructor(
    readonly commands: readonly LedgerCommand[],
    readonly net: number,
  ) {
    super(
      `Refusing to write an unbalanced ledger transaction: ${commands.length} ` +
        `entr${commands.length === 1 ? 'y' : 'ies'} with a net of ${net} IQD. ` +
        `Double-entry requires at least 2 entries summing to zero (CLAUDE.md §6.2).`,
    );
    this.name = 'UnbalancedLedgerError';
  }
}
