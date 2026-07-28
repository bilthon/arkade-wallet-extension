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
 *  • './keystore' → real module, with only the seed readers overridden.
 *  • './wallet-runtime' → `getSessionWallet`/`ensureFreshVtxos` spies, no real wallet.
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

const state = vi.hoisted(() => ({ seed: new Uint8Array(32).fill(1) as Uint8Array | null }));

// Keep the REAL `armAutoLock` and watch the alarm it creates, rather than spying on a
// mock of it. A spy only catches someone importing `armAutoLock` into this module by
// name; watching the alarm catches any transitive rearm, and it survives a rename.
vi.mock('./keystore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./keystore')>()),
  getUnlockedSeed: vi.fn(() => state.seed),
  isUnlocked: vi.fn(() => state.seed !== null),
}));

const wallet = vi.hoisted(() => ({}) as Wallet);
const getSessionWallet = vi.hoisted(() => vi.fn());
const ensureFreshVtxos = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('./wallet-runtime', () => ({ getSessionWallet, ensureFreshVtxos }));

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
  state.seed = new Uint8Array(32).fill(1);
  vi.resetAllMocks(); // clearAllMocks leaves mockImplementation in place, which leaks between cases
  getSessionWallet.mockResolvedValue(wallet);
});

describe('runRenewalTick', () => {
  it('uses the shared session wallet and never rearms auto-lock', async () => {
    const result = await runRenewalTick();

    expect(result.state).toBe('unlocked');
    expect(getSessionWallet).toHaveBeenCalledOnce();
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
    expect(ensureFreshVtxos).toHaveBeenCalledWith(wallet);
  });

  it('never asks for a wallet while locked', async () => {
    state.seed = null;

    const result = await runRenewalTick();

    expect(result.state).toBe('locked');
    expect(getSessionWallet).not.toHaveBeenCalled();
    expect(ensureFreshVtxos).not.toHaveBeenCalled();
    expect(alarmCreate).not.toHaveBeenCalled();
  });
});
