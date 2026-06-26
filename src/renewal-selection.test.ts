import { describe, it, expect } from 'vitest';
import type { ExtendedVirtualCoin } from '@arkade-os/sdk';
import {
  selectRenewable,
  translateSettleError,
  hasRecoverableOrExpired,
} from './wallet';

/**
 * Track F — the renew-vs-recover split (MUST-FIX #1; reproduced runtime bug).
 *
 * The reproduced failure: hitting "Renew" on an already-EXPIRED coin fed it to the
 * SDK's `renewVtxos`, and the operator rejected the round with `INVALID_INTENT_PROOF
 * (23): no matching intents found`. The SDK's own `getExpiringVtxos`/`renewVtxos`
 * collect "all expiring spendable virtual outputs *including recoverable ones*", so the
 * guard MUST live in our selection: only expiring-soon AND still-valid coins may reach
 * renewal. Already-expired/swept coins follow the recovery path instead.
 *
 * These exercise the real SDK predicates (`isExpired`/`isRecoverable`/`isSpendable`/
 * `isVtxoExpiringSoon`) on synthetic coins — verified to behave: `isExpired` is true on
 * state==="swept" OR a past `batchExpiry`; `isRecoverable` is true on swept-but-spendable.
 */

const HOUR = 60 * 60 * 1000;
const NOW = Date.now();
const MARGIN = 8 * 60 * 1000; // the scheduler's RENEW_MARGIN_MS

function vtxo(opts: {
  value: number;
  state?: 'preconfirmed' | 'settled' | 'swept' | 'spent';
  expiryMs?: number;
  isSpent?: boolean;
  txid?: string;
}): ExtendedVirtualCoin {
  const { value, state = 'settled', expiryMs, isSpent = false, txid = 'tx' } = opts;
  return {
    txid,
    vout: 0,
    value,
    isSpent,
    virtualStatus: { state, batchExpiry: expiryMs },
  } as unknown as ExtendedVirtualCoin;
}

describe('selectRenewable — only expiring-soon AND still-valid', () => {
  it('includes a coin expiring within the margin that is still valid', () => {
    const soon = vtxo({ value: 70_000, expiryMs: NOW + 5 * 60 * 1000, txid: 'soon' });
    expect(selectRenewable([soon], MARGIN)).toEqual([soon]);
  });

  it('EXCLUDES an already-expired coin (the reproduced INVALID_INTENT_PROOF cause)', () => {
    const expired = vtxo({ value: 50_000, state: 'settled', expiryMs: NOW - HOUR, txid: 'exp' });
    expect(selectRenewable([expired], MARGIN)).toEqual([]);
  });

  it('EXCLUDES a swept/recoverable coin (that is the recovery path, not renewal)', () => {
    const swept = vtxo({ value: 50_000, state: 'swept', expiryMs: NOW + 5 * HOUR, txid: 'swept' });
    expect(selectRenewable([swept], MARGIN)).toEqual([]);
  });

  it('excludes a coin not yet near expiry', () => {
    const far = vtxo({ value: 70_000, expiryMs: NOW + 5 * HOUR, txid: 'far' });
    expect(selectRenewable([far], MARGIN)).toEqual([]);
  });

  it('excludes a spent coin', () => {
    const spent = vtxo({ value: 9_000, isSpent: true, expiryMs: NOW + 60_000, txid: 'spent' });
    expect(selectRenewable([spent], MARGIN)).toEqual([]);
  });

  it('picks ONLY the renewable coin from a mixed set', () => {
    const soon = vtxo({ value: 70_000, expiryMs: NOW + 5 * 60 * 1000, txid: 'soon' });
    const expired = vtxo({ value: 50_000, expiryMs: NOW - HOUR, txid: 'exp' });
    const swept = vtxo({ value: 50_000, state: 'swept', expiryMs: NOW + 5 * HOUR, txid: 'swept' });
    const far = vtxo({ value: 80_000, expiryMs: NOW + 5 * HOUR, txid: 'far' });
    expect(selectRenewable([soon, expired, swept, far], MARGIN)).toEqual([soon]);
  });
});

describe('hasRecoverableOrExpired — the recover-first drain gate', () => {
  // `renewVtxos` re-derives its own input set (it ignores `selectRenewable`), so the
  // robust fix is to recover-first whenever any poisoning coin exists. This predicate
  // gates that drain: it must match the SDK's recovery set
  // (`isRecoverable || (isSpendable && isExpired)`).
  it('is true when a swept coin is present', () => {
    const swept = vtxo({ value: 50_000, state: 'swept', expiryMs: NOW + 5 * HOUR });
    expect(hasRecoverableOrExpired([swept])).toBe(true);
  });

  it('is true when a time-expired-but-unswept coin is present', () => {
    const expired = vtxo({ value: 50_000, state: 'settled', expiryMs: NOW - HOUR });
    expect(hasRecoverableOrExpired([expired])).toBe(true);
  });

  it('is false for only live + expiring-soon coins (nothing to drain)', () => {
    const live = vtxo({ value: 70_000, expiryMs: NOW + 5 * HOUR, txid: 'live' });
    const soon = vtxo({ value: 70_000, expiryMs: NOW + 5 * 60 * 1000, txid: 'soon' });
    expect(hasRecoverableOrExpired([live, soon])).toBe(false);
  });

  it('ignores spent coins', () => {
    const spentExpired = vtxo({ value: 9_000, isSpent: true, expiryMs: NOW - HOUR });
    expect(hasRecoverableOrExpired([spentExpired])).toBe(false);
  });
});

describe('translateSettleError — human, non-fatal intent messages', () => {
  it('translates INVALID_INTENT_PROOF into a retryable message', () => {
    const out = translateSettleError(
      new Error('INVALID_INTENT_PROOF (23): no matching intents found'),
    );
    expect(out).toBeInstanceOf(Error);
    expect(out!.message).toMatch(/try again/i);
    expect(out!.message).not.toMatch(/INVALID_INTENT_PROOF/);
  });

  it('translates a lingering "duplicated input" into a retryable message', () => {
    const out = translateSettleError(new Error('duplicated input on settle'));
    expect(out).toBeInstanceOf(Error);
    expect(out!.message).toMatch(/try again/i);
  });

  it('returns null for an unrelated error (caller rethrows as-is)', () => {
    expect(translateSettleError(new Error('network timeout'))).toBeNull();
    expect(translateSettleError('not an error')).toBeNull();
  });
});
