import { describe, it, expect } from 'vitest';
import type { ExtendedVirtualCoin, WalletBalance } from '@arkade-os/sdk';
import {
  partitionVtxos,
  adjustBalanceForExpiry,
  soonestExpiry,
  expiresAtMs,
  outpointOf,
  pickByOutpoints,
  COIN_GONE_MESSAGE,
} from './vtxo-state';

/**
 * Fixtures are synthetic VirtualCoins shaped to the SDK's `isExpired`/`isSpendable`
 * contract: `isExpired` is true when state==="swept" OR `batchExpiry` (epoch ms) is in
 * the past (ignoring obviously-non-time/block-height values); `isSpendable` is
 * `!isSpent`. We build only the fields those helpers read, cast through `unknown`.
 *
 * Raw balances here follow SDK 0.4.62, where `available` already excludes expired and
 * swept coins, `recoverable` is the sum of both of those, and `settled`/`preconfirmed`
 * include funds locked in a contract (`gated`).
 */

const HOUR = 60 * 60 * 1000;
const NOW = Date.now();

/** Build a synthetic VTXO. `expiryMs`: batch expiry (epoch ms) or undefined. */
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

/** A plausible raw SDK balance. Callers override the spendable buckets. */
function balance(over: Partial<WalletBalance>): WalletBalance {
  return {
    boarding: { confirmed: 0, unconfirmed: 0, total: 0 },
    settled: 0,
    preconfirmed: 0,
    available: 0,
    gated: 0,
    intentLocked: 0,
    recoverable: 0,
    pendingRecovery: 0,
    total: 0,
    assets: [],
    ...over,
  } as WalletBalance;
}

describe('expiresAtMs', () => {
  it('returns the batch expiry for a real timestamp', () => {
    const at = NOW + 2 * HOUR;
    expect(expiresAtMs(vtxo({ value: 1, expiryMs: at }))).toBe(at);
  });

  it('returns null when there is no batch expiry', () => {
    expect(expiresAtMs(vtxo({ value: 1 }))).toBeNull();
  });

  it('treats an obviously-non-time value (block height) as no expiry', () => {
    // A small integer is a regtest block height, not an epoch-ms timestamp.
    expect(expiresAtMs(vtxo({ value: 1, expiryMs: 1024 }))).toBeNull();
  });
});

describe('partitionVtxos', () => {
  it('puts a live spendable coin in spendable, an expired one in expired', () => {
    const live = vtxo({ value: 70_000, expiryMs: NOW + 2 * HOUR });
    const expired = vtxo({ value: 100_000_000, expiryMs: NOW - HOUR, txid: 'old' });
    const part = partitionVtxos([live, expired]);
    expect(part.spendable).toEqual([live]);
    expect(part.expired).toEqual([expired]);
    expect(part.expiredSats).toBe(100_000_000);
  });

  it('routes a swept coin to recoverable, NOT expired', () => {
    // A swept coin is recoverable (operator re-issues via recoverVtxos), not renewable.
    // It must NOT land in `expired` — that bucket drives the `available` drain, and the
    // SDK already excludes swept coins from `available`.
    const swept = vtxo({ value: 50_000, state: 'swept', expiryMs: NOW + 5 * HOUR });
    const part = partitionVtxos([swept]);
    expect(part.recoverable).toEqual([swept]);
    expect(part.recoverableSats).toBe(50_000);
    expect(part.expired).toEqual([]);
    expect(part.spendable).toEqual([]);
  });

  it('drops already-spent coins from both buckets', () => {
    const spent = vtxo({ value: 9_000, isSpent: true });
    const part = partitionVtxos([spent]);
    expect(part.spendable).toEqual([]);
    expect(part.expired).toEqual([]);
    expect(part.expiredSats).toBe(0);
  });
});

describe('adjustBalanceForExpiry', () => {
  it('reports an elapsed-but-unswept VTXO as expired, and leaves available alone', () => {
    // SDK 0.4.62 already routes this coin to `recoverable` and keeps it out of
    // `available`, so we must not subtract it a second time.
    const expired = vtxo({ value: 100_000_000, state: 'settled', expiryMs: NOW - HOUR });
    const raw = balance({
      settled: 0,
      preconfirmed: 0,
      available: 0,
      recoverable: 100_000_000,
      total: 100_000_000,
    });

    const adj = adjustBalanceForExpiry(raw, [expired]);

    expect(adj.available).toBe(0);
    expect(adj.expired).toBe(100_000_000);
    // The funds still exist, so total is untouched.
    expect(adj.total).toBe(100_000_000);
  });

  it('leaves a swap lockup gated and out of available', () => {
    // A funded VHTLC lockup counts in `settled` but not in `available`. Recomputing
    // available as settled + preconfirmed would hand the lockup back as spendable.
    const live = vtxo({ value: 80_000, state: 'settled', expiryMs: NOW + 3 * HOUR });
    const raw = balance({
      settled: 100_000,
      preconfirmed: 0,
      available: 80_000,
      gated: 20_000,
      total: 100_000,
    });

    const adj = adjustBalanceForExpiry(raw, [live]);

    expect(adj.available).toBe(80_000);
    expect(adj.gated).toBe(20_000);
    expect(adj.settled).toBe(100_000);
  });

  it('keeps a live coin fully available and reports its expiry', () => {
    const at = NOW + 3 * HOUR;
    const live = vtxo({ value: 70_000, state: 'settled', expiryMs: at });
    const raw = balance({ settled: 70_000, available: 70_000, total: 70_000 });

    const adj = adjustBalanceForExpiry(raw, [live]);

    expect(adj.available).toBe(70_000);
    expect(adj.expired).toBe(0);
    expect(adj.nextExpiryAtMs).toBe(at);
  });

  it('splits the SDK recoverable figure into expired and swept', () => {
    // The SDK reports one `recoverable` number covering both cases. They are fixed by
    // different calls, so we report them apart and their sum must match that number.
    const live = vtxo({ value: 40_000, state: 'settled', expiryMs: NOW + HOUR, txid: 'live' });
    const timeExpired = vtxo({ value: 30_000, state: 'settled', expiryMs: NOW - HOUR, txid: 'exp' });
    const swept = vtxo({ value: 50_000, state: 'swept', expiryMs: NOW - 2 * HOUR, txid: 'swept' });
    const raw = balance({
      settled: 40_000,
      available: 40_000,
      recoverable: 80_000, // the elapsed 30k plus the swept 50k
      total: 120_000,
    });

    const adj = adjustBalanceForExpiry(raw, [live, timeExpired, swept]);

    expect(adj.available).toBe(40_000);
    expect(adj.expired).toBe(30_000);
    expect(adj.recoverableSats).toBe(50_000);
    expect(adj.expired + adj.recoverableSats).toBe(raw.recoverable);
  });

  it('counts a swept coin once, in recoverableSats only', () => {
    // recoverableSats comes from our own VTXO sum. Reading the SDK's `recoverable`
    // instead would fold in the expired bucket and count those coins twice, because
    // the wallet home adds `expired` and `recoverableSats` together.
    const live = vtxo({ value: 70_000, state: 'settled', expiryMs: NOW + 3 * HOUR, txid: 'live' });
    const swept = vtxo({ value: 50_000, state: 'swept', expiryMs: NOW - HOUR, txid: 'swept' });
    const raw = balance({
      settled: 70_000,
      available: 70_000,
      recoverable: 50_000,
      total: 120_000,
    });

    const adj = adjustBalanceForExpiry(raw, [live, swept]);

    expect(adj.available).toBe(70_000);
    expect(adj.expired).toBe(0);
    expect(adj.recoverableSats).toBe(50_000);
    expect(adj.total).toBe(120_000);
  });
});

describe('soonestExpiry', () => {
  it('returns the earliest expiry across coins', () => {
    const a = vtxo({ value: 1, expiryMs: NOW + 5 * HOUR, txid: 'a' });
    const b = vtxo({ value: 1, expiryMs: NOW + 2 * HOUR, txid: 'b' });
    const c = vtxo({ value: 1, txid: 'c' }); // no expiry → ignored
    expect(soonestExpiry([a, b, c])).toBe(NOW + 2 * HOUR);
  });

  it('returns null when no coin has a wall-clock expiry', () => {
    expect(soonestExpiry([vtxo({ value: 1 })])).toBeNull();
  });
});

describe('pickByOutpoints — coin-control input resolution', () => {
  it('resolves outpoints to their coins, preserving the requested order', () => {
    const a = vtxo({ value: 10_000, txid: 'aa' });
    const b = vtxo({ value: 20_000, txid: 'bb' });
    const c = vtxo({ value: 30_000, txid: 'cc' });
    // Ask for c then a — the result order must follow the outpoints, not the input list.
    const picked = pickByOutpoints([a, b, c], [outpointOf(c), outpointOf(a)]);
    expect(picked).toEqual([c, a]);
  });

  it('throws the reselect message when an outpoint is missing (renewed/spent since)', () => {
    const a = vtxo({ value: 10_000, txid: 'aa' });
    expect(() => pickByOutpoints([a], ['bb:0'])).toThrowError(COIN_GONE_MESSAGE);
  });

  it('treats a non-spendable coin as a miss (callers pass only the spendable bucket)', () => {
    // The send path resolves against partitionVtxos().spendable, so an expired coin the
    // popup listed is simply absent here and reads as gone.
    const spendable = vtxo({ value: 10_000, txid: 'live' });
    const expired = vtxo({ value: 40_000, txid: 'old', expiryMs: NOW - HOUR });
    const { spendable: onlySpendable } = partitionVtxos([spendable, expired]);
    expect(() => pickByOutpoints(onlySpendable, [outpointOf(expired)])).toThrowError(
      COIN_GONE_MESSAGE,
    );
  });
});
