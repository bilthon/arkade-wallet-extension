import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NetworkName, Wallet } from '@arkade-os/sdk';

/**
 * Session-scoped wallet runtime tests.
 *
 * Module mocking strategy:
 *  • './keystore' → `getUnlockedSeed`/`isUnlocked` read a controllable in-test seed.
 *  • './storage' → `getNetwork` reads a controllable in-test network.
 *  • './wallet' → `buildWallet` is a bare mock (no real SDK/IndexedDB construction);
 *    the runtime only ever calls this one export from './wallet'.
 */

const state = vi.hoisted(() => ({
  seed: new Uint8Array(32).fill(1) as Uint8Array | null,
  network: 'regtest' as NetworkName,
}));

vi.mock('./keystore', () => ({
  getUnlockedSeed: vi.fn(() => state.seed),
  isUnlocked: vi.fn(() => state.seed !== null),
}));

vi.mock('./storage', () => ({
  getNetwork: vi.fn(async () => state.network),
}));

const buildWalletMock = vi.hoisted(() => vi.fn());
vi.mock('./wallet', () => ({
  buildWallet: buildWalletMock,
}));

// Import AFTER vi.mock so the mocked modules are in place.
import { getSessionWallet, invalidateSessionWallet, ensureFreshVtxos } from './wallet-runtime';

/** A promise plus its resolve/reject, for controlling exactly when a build settles. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A fake `Wallet` — only the surface `wallet-runtime.ts` calls. */
function fakeWallet(overrides: Record<string, unknown> = {}) {
  return {
    dispose: vi.fn(async () => {}),
    getContractManager: vi.fn(async () => ({ refreshVtxos: vi.fn(async () => {}) })),
    ...overrides,
  } as unknown as Wallet;
}

beforeEach(async () => {
  await invalidateSessionWallet(); // module-level cache must not leak across tests
  state.seed = new Uint8Array(32).fill(1);
  state.network = 'regtest';
  buildWalletMock.mockReset();
});

describe('getSessionWallet', () => {
  it('builds exactly one wallet for concurrent requests, and both get the same object', async () => {
    const wallet = fakeWallet();
    const gate = deferred<Wallet>();
    buildWalletMock.mockReturnValueOnce(gate.promise);

    const p1 = getSessionWallet();
    const p2 = getSessionWallet();
    gate.resolve(wallet);

    const [a, b] = await Promise.all([p1, p2]);
    expect(a).toBe(wallet);
    expect(b).toBe(wallet);
    expect(buildWalletMock).toHaveBeenCalledOnce();
  });

  it('does not rebuild for repeated requests on the same network', async () => {
    const wallet = fakeWallet();
    buildWalletMock.mockResolvedValue(wallet);

    const a = await getSessionWallet();
    const b = await getSessionWallet();

    expect(a).toBe(wallet);
    expect(b).toBe(wallet);
    expect(buildWalletMock).toHaveBeenCalledOnce();
  });

  it('lets a failed build be retried', async () => {
    buildWalletMock.mockRejectedValueOnce(new Error('operator unreachable'));
    const wallet = fakeWallet();
    buildWalletMock.mockResolvedValueOnce(wallet);

    await expect(getSessionWallet()).rejects.toThrow('operator unreachable');
    const b = await getSessionWallet();

    expect(b).toBe(wallet);
    expect(buildWalletMock).toHaveBeenCalledTimes(2);
  });

  it('clears the memo on a build timeout, so the next request builds again', async () => {
    vi.useFakeTimers();
    try {
      buildWalletMock.mockReturnValueOnce(new Promise<Wallet>(() => {})); // hangs forever

      const timedOut = getSessionWallet();
      const assertion = expect(timedOut).rejects.toThrow(/timed out/i);
      await vi.advanceTimersByTimeAsync(8_000);
      await assertion;

      const wallet = fakeWallet();
      buildWalletMock.mockResolvedValueOnce(wallet);
      const b = await getSessionWallet();

      expect(b).toBe(wallet);
      expect(buildWalletMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('disposes a resolved wallet once when invalidated, even if called twice', async () => {
    const wallet = fakeWallet();
    buildWalletMock.mockResolvedValueOnce(wallet);
    await getSessionWallet();

    await invalidateSessionWallet();
    await invalidateSessionWallet();

    expect(wallet.dispose).toHaveBeenCalledOnce();
  });

  it('disposes itself, uncached, when the build completes after an invalidation', async () => {
    const first = fakeWallet();
    const gate = deferred<Wallet>();
    buildWalletMock.mockReturnValueOnce(gate.promise);

    const building = getSessionWallet();
    // Let the build actually reach buildWallet() (i.e. capture its generation and
    // seed) before invalidating, so this exercises the build being mid-flight
    // rather than invalidating before it even started.
    await vi.waitFor(() => expect(buildWalletMock).toHaveBeenCalled());
    await invalidateSessionWallet(); // bumps generation while the build is in flight

    gate.resolve(first);
    await expect(building).rejects.toThrow('LOCKED');
    expect(first.dispose).toHaveBeenCalledOnce();

    // The next call rebuilds cleanly instead of reusing the self-destructed wallet.
    const second = fakeWallet();
    buildWalletMock.mockResolvedValueOnce(second);
    const b = await getSessionWallet();
    expect(b).toBe(second);
    expect(buildWalletMock).toHaveBeenCalledTimes(2);
  });

  it('disposes itself, uncached, when the build completes after a lock (generation unchanged)', async () => {
    const wallet = fakeWallet();
    const gate = deferred<Wallet>();
    buildWalletMock.mockReturnValueOnce(gate.promise);

    const building = getSessionWallet();
    // Let the build capture the seed before it changes underneath it.
    await vi.waitFor(() => expect(buildWalletMock).toHaveBeenCalled());
    state.seed = null; // a lock landed mid-build, without ever calling invalidateSessionWallet

    gate.resolve(wallet);
    await expect(building).rejects.toThrow('LOCKED');
    expect(wallet.dispose).toHaveBeenCalledOnce();
  });

  it('disposes the old wallet and builds against the new network on a network change', async () => {
    const first = fakeWallet();
    const second = fakeWallet();
    buildWalletMock.mockResolvedValueOnce(first).mockResolvedValueOnce(second);

    const a = await getSessionWallet();
    expect(a).toBe(first);
    expect(buildWalletMock).toHaveBeenLastCalledWith(expect.anything(), 'regtest');

    state.network = 'mutinynet';
    const b = await getSessionWallet();

    expect(first.dispose).toHaveBeenCalledOnce();
    expect(b).toBe(second);
    expect(b).not.toBe(a);
    expect(buildWalletMock).toHaveBeenLastCalledWith(expect.anything(), 'mutinynet');
  });

  it('does not leave the old wallet cached when its disposal fails', async () => {
    const wallet = fakeWallet({
      dispose: vi.fn(async () => {
        throw new Error('dispose blew up');
      }),
    });
    buildWalletMock.mockResolvedValueOnce(wallet);
    await getSessionWallet();

    await expect(invalidateSessionWallet()).resolves.toBeUndefined();

    const second = fakeWallet();
    buildWalletMock.mockResolvedValueOnce(second);
    const b = await getSessionWallet();
    expect(b).toBe(second);
  });
});

describe('ensureFreshVtxos', () => {
  it('performs one refreshVtxos() for concurrent calls', async () => {
    const gate = deferred<void>();
    const refreshVtxos = vi.fn(() => gate.promise);
    const wallet = fakeWallet({ getContractManager: vi.fn(async () => ({ refreshVtxos })) });

    const p1 = ensureFreshVtxos(wallet);
    const p2 = ensureFreshVtxos(wallet);
    gate.resolve();
    await Promise.all([p1, p2]);

    expect(refreshVtxos).toHaveBeenCalledOnce();
  });

  it('does not refresh again for a second call inside the freshness window', async () => {
    const refreshVtxos = vi.fn(async () => {});
    const wallet = fakeWallet({ getContractManager: vi.fn(async () => ({ refreshVtxos })) });

    await ensureFreshVtxos(wallet, 10_000);
    await ensureFreshVtxos(wallet, 10_000);

    expect(refreshVtxos).toHaveBeenCalledOnce();
  });

  it('clears the memo on failure so the next call retries', async () => {
    const refreshVtxos = vi
      .fn()
      .mockRejectedValueOnce(new Error('indexer down'))
      .mockResolvedValueOnce(undefined);
    const wallet = fakeWallet({ getContractManager: vi.fn(async () => ({ refreshVtxos })) });

    await expect(ensureFreshVtxos(wallet, 0)).rejects.toThrow('indexer down');
    await expect(ensureFreshVtxos(wallet, 0)).resolves.toBeUndefined();

    expect(refreshVtxos).toHaveBeenCalledTimes(2);
  });

  it('clears the memo on a timeout so the next call retries', async () => {
    vi.useFakeTimers();
    try {
      const refreshVtxos = vi
        .fn()
        .mockReturnValueOnce(new Promise<void>(() => {})) // hangs forever
        .mockResolvedValueOnce(undefined);
      const wallet = fakeWallet({ getContractManager: vi.fn(async () => ({ refreshVtxos })) });

      const stuck = ensureFreshVtxos(wallet, 0);
      const assertion = expect(stuck).rejects.toThrow(/timed out/i);
      await vi.advanceTimersByTimeAsync(60_000);
      await assertion;

      await expect(ensureFreshVtxos(wallet, 0)).resolves.toBeUndefined();
      expect(refreshVtxos).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * Regressions found reviewing the first cut of this module. Each one is a lifetime
 * gap: work that outlives the wallet it belongs to, or a wallet that outlives the
 * unlocked session. They are grouped because they share that shape, not because they
 * share code.
 */
describe('lifetime gaps', () => {
  it('throws LOCKED on the cache-hit path, not just when building', async () => {
    const wallet = fakeWallet();
    buildWalletMock.mockResolvedValue(wallet);
    expect(await getSessionWallet()).toBe(wallet);

    // `lock()` zeroes the seed and then awaits two storage writes before its listeners
    // reach invalidateSessionWallet, so this state is reachable in production.
    state.seed = null;

    await expect(getSessionWallet()).rejects.toThrow('LOCKED');
  });

  it('bounds the whole refresh, so a hung getContractManager cannot wedge later callers', async () => {
    vi.useFakeTimers();
    try {
      const hung = fakeWallet({ getContractManager: vi.fn(() => new Promise(() => {})) });
      const first = ensureFreshVtxos(hung, 0);
      const assertion = expect(first).rejects.toThrow(/timed out/i);
      await vi.advanceTimersByTimeAsync(60_000);
      await assertion;

      // The memo cleared, so a healthy wallet refreshes normally afterwards.
      const refreshVtxos = vi.fn(async () => {});
      const healthy = fakeWallet({ getContractManager: vi.fn(async () => ({ refreshVtxos })) });
      await ensureFreshVtxos(healthy, 0);
      expect(refreshVtxos).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not stamp the freshness window from a refresh that outlived its wallet', async () => {
    const gate = deferred<void>();
    const oldWallet = fakeWallet({
      getContractManager: vi.fn(async () => ({ refreshVtxos: vi.fn(() => gate.promise) })),
    });
    const inFlight = ensureFreshVtxos(oldWallet, 0);
    await vi.waitFor(() => expect(oldWallet.getContractManager).toHaveBeenCalled());

    await invalidateSessionWallet(); // lock, or a network switch
    gate.resolve();
    await inFlight;

    // The next wallet was never reconciled, so it must not count as fresh.
    const refreshVtxos = vi.fn(async () => {});
    const newWallet = fakeWallet({ getContractManager: vi.fn(async () => ({ refreshVtxos })) });
    await ensureFreshVtxos(newWallet, 10_000);
    expect(refreshVtxos).toHaveBeenCalledOnce();
  });

  it('disposes a build that lost the timeout race', async () => {
    vi.useFakeTimers();
    try {
      const late = fakeWallet();
      const gate = deferred<Wallet>();
      buildWalletMock.mockReturnValueOnce(gate.promise);

      const timedOut = getSessionWallet();
      const assertion = expect(timedOut).rejects.toThrow(/timed out/i);
      await vi.advanceTimersByTimeAsync(8_000);
      await assertion;

      gate.resolve(late); // the slow operator finally answers
      await vi.advanceTimersByTimeAsync(0);

      expect(late.dispose).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
