import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Wallet } from '@arkade-os/sdk';

/**
 * Scheduled renewal tick.
 *
 * The tick is maintenance, not user activity, so the thing most worth testing is what
 * it must NOT do: extend the auto-lock deadline, or touch the wallet while locked. The
 * alarm fires every minute, so a tick that rearmed the ten-minute deadline would mean
 * the wallet never auto-locks while the service worker lives.
 *
 * Module mocking strategy:
 *  • './wallet-runtime' → unlock gate + wallet/freshness spies, no real wallet.
 *  • './wallet' → the three settle/read helpers the tick calls.
 */

// The tick reads and writes the warning snapshot through `browser.storage.local`,
// so stub the same minimal surface `keystore.test.ts` does.
const alarmCreate = vi.hoisted(() => vi.fn(async () => {}));
const local = new Map<string, unknown>();
vi.stubGlobal('browser', {
  storage: {
    local: {
      get: vi.fn(async (key: string) => ({ [key]: local.get(key) })),
      set: vi.fn(async (items: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(items)) local.set(k, v);
      }),
      remove: vi.fn(async (key: string) => void local.delete(key)),
    },
  },
  alarms: { create: alarmCreate, clear: vi.fn(async () => {}), onAlarm: { addListener: vi.fn() } },
});

const state = vi.hoisted(() => ({ unlocked: true }));

const wallet = vi.hoisted(() => ({}) as Wallet);
const context = vi.hoisted(() => ({
  wallet,
  network: 'regtest' as const,
  epoch: 1,
  assertCurrent: vi.fn(),
}));
const getSessionContext = vi.hoisted(() => vi.fn());
const ensureFreshVtxos = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('./wallet-runtime', () => ({
  getSessionContext,
  ensureFreshVtxos,
  isUnlocked: () => state.unlocked,
}));

const recoverExpiredVtxos = vi.hoisted(() => vi.fn(async () => ({ recovered: 0, sats: 0 })));
const renewExpiringVtxos = vi.hoisted(() => vi.fn(async () => ({ renewed: 0 })));
const getExpiredVtxoSummary = vi.hoisted(() =>
  vi.fn(async () => ({
    expiredSats: 0,
    count: 0,
    recoverableSats: 0,
    recoverableCount: 0,
    nextExpiryAtMs: null,
  })),
);
vi.mock('./wallet', () => ({
  recoverExpiredVtxos,
  renewExpiringVtxos,
  getExpiredVtxoSummary,
}));

// Import AFTER vi.mock so the mocked modules are in place.
import { runRenewalTick } from './renewal';

beforeEach(() => {
  state.unlocked = true;
  vi.resetAllMocks();
  getSessionContext.mockResolvedValue(context);
  ensureFreshVtxos.mockResolvedValue(undefined);
  recoverExpiredVtxos.mockResolvedValue({ recovered: 0, sats: 0 });
  renewExpiringVtxos.mockResolvedValue({ renewed: 0 });
  getExpiredVtxoSummary.mockResolvedValue({
    expiredSats: 0,
    count: 0,
    recoverableSats: 0,
    recoverableCount: 0,
    nextExpiryAtMs: null,
  });
});

describe('runRenewalTick', () => {
  it('uses the shared session wallet and never rearms auto-lock', async () => {
    const result = await runRenewalTick();

    expect(result.state).toBe('unlocked');
    expect(getSessionContext).toHaveBeenCalledOnce();
    // The whole point of the maintenance path: the idle window must not move. The
    // auto-lock alarm is how it moves, so assert none was ever created.
    expect(alarmCreate).not.toHaveBeenCalled();
  });

  it('does not move the deadline across repeated ticks either', async () => {
    await runRenewalTick();
    await runRenewalTick();
    await runRenewalTick();

    expect(alarmCreate).not.toHaveBeenCalled();
  });

  it('refreshes VTXOs before selecting coins to recover or renew', async () => {
    const order: string[] = [];
    ensureFreshVtxos.mockImplementation(async () => void order.push('refresh'));
    recoverExpiredVtxos.mockImplementation(async () => {
      order.push('recover');
      return { recovered: 0, sats: 0 };
    });
    renewExpiringVtxos.mockImplementation(async () => {
      order.push('renew');
      return { renewed: 0 };
    });

    await runRenewalTick();

    // Selection reads the contract repository, so a stale cache here risks feeding a
    // swept coin into a renew round. Recover must still come before renew.
    expect(order).toEqual(['refresh', 'recover', 'renew']);
    expect(ensureFreshVtxos).toHaveBeenCalledWith(context);
  });

  it('never asks for a wallet while locked', async () => {
    state.unlocked = false;

    const result = await runRenewalTick();

    expect(result.state).toBe('locked');
    expect(getSessionContext).not.toHaveBeenCalled();
    expect(ensureFreshVtxos).not.toHaveBeenCalled();
    expect(alarmCreate).not.toHaveBeenCalled();
  });

  it('propagates LOCKED from a stale recovery context and skips renewal', async () => {
    recoverExpiredVtxos.mockRejectedValue(new Error('LOCKED'));

    await expect(runRenewalTick()).rejects.toThrow('LOCKED');

    expect(renewExpiringVtxos).not.toHaveBeenCalled();
  });
});
