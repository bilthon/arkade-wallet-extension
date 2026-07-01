import { describe, it, expect } from 'vitest';
import type { ExtendedVirtualCoin, WalletBalance } from '@arkade-os/sdk';
import {
  partitionVtxos,
  adjustBalanceForExpiry,
  soonestExpiry,
  expiresAtMs,
} from './vtxo-state';

/**
 * The confirmed-bug fix: an expired-but-unswept VTXO must NOT
 * count as `available`, and the renewal-trigger decision must be a pure function.
 *
 * Fixtures are synthetic VirtualCoins shaped to the SDK's `isExpired`/`isSpendable`
 * contract: `isExpired` is true when state==="swept" OR `batchExpiry` (epoch ms) is in
 * the past (ignoring obviously-non-time/block-height values); `isSpendable` is
 * `!isSpent`. We build only the fields those helpers read, cast through `unknown`.
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

describe('adjustBalanceForExpiry — the core fix', () => {
  it('excludes an expired-but-unswept VTXO from available', () => {
    // The bug: a 1 BTC coin expired but state is still "settled", so the raw SDK
    // balance counts it in settled/available. After adjustment it must be 0 there.
    const expired = vtxo({ value: 100_000_000, state: 'settled', expiryMs: NOW - HOUR });
    const raw = balance({
      settled: 100_000_000,
      preconfirmed: 0,
      available: 100_000_000,
      total: 100_000_000,
    });

    const adj = adjustBalanceForExpiry(raw, [expired]);

    expect(adj.available).toBe(0);
    expect(adj.settled).toBe(0);
    expect(adj.expired).toBe(100_000_000);
    // The funds still exist — total is untouched.
    expect(adj.total).toBe(100_000_000);
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

  it('drains preconfirmed before settled', () => {
    // 30k expired; raw split is 20k preconfirmed + 60k settled (available 80k).
    // Drain 20k from preconfirmed (→0), remaining 10k from settled (→50k).
    const expired = vtxo({ value: 30_000, state: 'settled', expiryMs: NOW - HOUR });
    const live = vtxo({ value: 50_000, state: 'settled', expiryMs: NOW + HOUR, txid: 'live' });
    const raw = balance({
      settled: 60_000,
      preconfirmed: 20_000,
      available: 80_000,
      total: 80_000,
    });

    const adj = adjustBalanceForExpiry(raw, [expired, live]);

    expect(adj.preconfirmed).toBe(0);
    expect(adj.settled).toBe(50_000);
    expect(adj.available).toBe(50_000);
    expect(adj.expired).toBe(30_000);
  });

  it('does NOT re-drain a swept coin coexisting with a live coin (double-drain fix)', () => {
    // The bug: `adjustBalanceForExpiry` subtracted ALL isExpired&&isSpendable coins
    // (which includes swept/recoverable) from available. But the SDK's getBalance()
    // already puts swept coins ONLY in `recoverable`, never in `available`. So with a
    // live 70k coin + a swept 50k coin, the raw balance is available=70k, recoverable=50k.
    // Subtracting the swept 50k again would understate available to 20k. After the fix
    // available must stay 70k (only the live coin), and recoverableSats must surface 50k.
    const live = vtxo({ value: 70_000, state: 'settled', expiryMs: NOW + 3 * HOUR, txid: 'live' });
    const swept = vtxo({ value: 50_000, state: 'swept', expiryMs: NOW - HOUR, txid: 'swept' });
    const raw = balance({
      settled: 70_000,
      preconfirmed: 0,
      available: 70_000, // SDK already excluded the swept coin from here
      recoverable: 50_000, // …and accounted for it here
      total: 120_000,
    });

    const adj = adjustBalanceForExpiry(raw, [live, swept]);

    // Available reflects ONLY the live coin — the swept coin is not re-subtracted.
    expect(adj.available).toBe(70_000);
    expect(adj.settled).toBe(70_000);
    // No time-expired-unswept coins here.
    expect(adj.expired).toBe(0);
    // The swept value is surfaced for the Recover bucket (from the SDK's own field).
    expect(adj.recoverableSats).toBe(50_000);
    expect(adj.total).toBe(120_000);
  });

  it('drains a time-expired-unswept coin but leaves a coexisting swept coin alone', () => {
    // Mixed: a live 40k, a time-expired-unswept 30k (state still settled → still in
    // available, must drain), and a swept 50k (recoverable, must NOT drain).
    const live = vtxo({ value: 40_000, state: 'settled', expiryMs: NOW + HOUR, txid: 'live' });
    const timeExpired = vtxo({ value: 30_000, state: 'settled', expiryMs: NOW - HOUR, txid: 'exp' });
    const swept = vtxo({ value: 50_000, state: 'swept', expiryMs: NOW - 2 * HOUR, txid: 'swept' });
    const raw = balance({
      settled: 70_000, // live 40k + time-expired 30k (swept already excluded by SDK)
      available: 70_000,
      recoverable: 50_000,
      total: 120_000,
    });

    const adj = adjustBalanceForExpiry(raw, [live, timeExpired, swept]);

    expect(adj.available).toBe(40_000); // only the live coin
    expect(adj.expired).toBe(30_000); // the time-expired-unswept coin
    expect(adj.recoverableSats).toBe(50_000); // the swept coin, not re-drained
  });

  it('clamps at zero when expired value exceeds the spendable buckets', () => {
    // Defensive: indexer balance and VTXO sum disagree → never go negative.
    const expired = vtxo({ value: 200_000, state: 'settled', expiryMs: NOW - HOUR });
    const raw = balance({ settled: 50_000, available: 50_000, total: 50_000 });

    const adj = adjustBalanceForExpiry(raw, [expired]);

    expect(adj.available).toBe(0);
    expect(adj.settled).toBe(0);
    expect(adj.preconfirmed).toBe(0);
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
