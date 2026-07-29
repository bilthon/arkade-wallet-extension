import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SeedIdentity, type NetworkName, type Wallet } from '@arkade-os/sdk';

const mnemonicToSeedMock = vi.hoisted(() => vi.fn());
vi.mock('./crypto', () => ({ mnemonicToSeed: mnemonicToSeedMock }));

const buildWalletMock = vi.hoisted(() => vi.fn());
vi.mock('./wallet', () => ({
  buildWallet: buildWalletMock,
  networkConfig: (network: NetworkName) => ({ isMainnet: network === 'bitcoin' }),
}));

import {
  beginSessionLock,
  ensureFreshVtxos,
  getSessionContext,
  getSessionNetwork,
  invalidateSessionWallet,
  isUnlocked,
  openSession,
  type SessionContext,
} from './wallet-runtime';

const MNEMONIC = 'runtime test mnemonic';
let temporarySeed: Uint8Array;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeWallet(overrides: Record<string, unknown> = {}) {
  return {
    dispose: vi.fn(async () => {}),
    getContractManager: vi.fn(async () => ({ refreshVtxos: vi.fn(async () => {}) })),
    getVtxoManager: vi.fn(async () => ({})),
    ...overrides,
  } as unknown as Wallet;
}

async function installContext(wallet: Wallet): Promise<SessionContext> {
  buildWalletMock.mockResolvedValueOnce(wallet);
  return getSessionContext();
}

beforeEach(async () => {
  const previous = beginSessionLock();
  await previous.disposal;
  buildWalletMock.mockReset();
  mnemonicToSeedMock.mockReset();
  mnemonicToSeedMock.mockImplementation(() => {
    temporarySeed = new Uint8Array(64).fill(7);
    return temporarySeed;
  });
  await openSession(MNEMONIC, 'regtest');
});

describe('runtime session ownership', () => {
  it('opens locally without building a wallet and clears the temporary seed', () => {
    expect(isUnlocked()).toBe(true);
    expect(getSessionNetwork()).toBe('regtest');
    expect(buildWalletMock).not.toHaveBeenCalled();
    expect(temporarySeed.every((byte) => byte === 0)).toBe(true);
  });

  it('clears the temporary seed and preserves the prior session if identity creation fails', () => {
    const fromSeed = vi.spyOn(SeedIdentity, 'fromSeed').mockImplementationOnce(() => {
      throw new Error('bad identity');
    });

    expect(() => openSession('bad', 'mutinynet')).toThrow('bad identity');
    expect(temporarySeed.every((byte) => byte === 0)).toBe(true);
    expect(isUnlocked()).toBe(true);
    expect(getSessionNetwork()).toBe('regtest');
    fromSeed.mockRestore();
  });

  it('passes a SeedIdentity and the captured network to the wallet builder', async () => {
    const wallet = fakeWallet();
    buildWalletMock.mockResolvedValueOnce(wallet);

    await expect(getSessionContext()).resolves.toMatchObject({ wallet });

    expect(buildWalletMock).toHaveBeenCalledWith(expect.any(SeedIdentity), 'regtest');
    expect(buildWalletMock.mock.calls[0][0]).not.toBe(temporarySeed);
  });

  it('revokes a captured context when the session locks', async () => {
    const context = await installContext(fakeWallet());

    const transition = beginSessionLock();
    expect(() => context.assertCurrent()).toThrow('LOCKED');
    await transition.disposal;
  });

  it('revokes a captured context when the wallet is invalidated', async () => {
    const context = await installContext(fakeWallet());

    await invalidateSessionWallet();

    expect(() => context.assertCurrent()).toThrow('LOCKED');
  });

  it('revokes a captured context when the same network is reopened', async () => {
    const context = await installContext(fakeWallet());

    await openSession(MNEMONIC, 'regtest');

    expect(() => context.assertCurrent()).toThrow('LOCKED');
  });

  it('revokes synchronously and is idempotent', async () => {
    const wallet = fakeWallet();
    await installContext(wallet);

    const first = beginSessionLock();
    expect(first.didLock).toBe(true);
    expect(isUnlocked()).toBe(false);
    await expect(getSessionContext()).rejects.toThrow('LOCKED');
    await first.disposal;

    const second = beginSessionLock();
    expect(second.didLock).toBe(false);
    await second.disposal;
    expect(wallet.dispose).toHaveBeenCalledOnce();
  });
});

describe('getSessionContext', () => {
  it('builds exactly once for concurrent callers', async () => {
    const wallet = fakeWallet();
    const gate = deferred<Wallet>();
    buildWalletMock.mockReturnValueOnce(gate.promise);

    const first = getSessionContext();
    const second = getSessionContext();
    gate.resolve(wallet);

    const contexts = await Promise.all([first, second]);
    expect(contexts.map((context) => context.wallet)).toEqual([wallet, wallet]);
    expect(buildWalletMock).toHaveBeenCalledOnce();
  });

  it('reuses the resolved wallet', async () => {
    const wallet = fakeWallet();
    buildWalletMock.mockResolvedValueOnce(wallet);

    expect((await getSessionContext()).wallet).toBe(wallet);
    expect((await getSessionContext()).wallet).toBe(wallet);
    expect(buildWalletMock).toHaveBeenCalledOnce();
  });

  it('allows a failed build to be retried', async () => {
    buildWalletMock.mockRejectedValueOnce(new Error('operator unreachable'));
    const wallet = fakeWallet();
    buildWalletMock.mockResolvedValueOnce(wallet);

    await expect(getSessionContext()).rejects.toThrow('operator unreachable');
    await expect(getSessionContext()).resolves.toMatchObject({ wallet });
    expect(buildWalletMock).toHaveBeenCalledTimes(2);
  });

  it('clears the memo after a timeout so the next request can retry', async () => {
    vi.useFakeTimers();
    try {
      buildWalletMock.mockReturnValueOnce(new Promise<Wallet>(() => {}));
      const timedOut = getSessionContext();
      const assertion = expect(timedOut).rejects.toThrow(/timed out/i);
      await vi.advanceTimersByTimeAsync(8_000);
      await assertion;

      const wallet = fakeWallet();
      buildWalletMock.mockResolvedValueOnce(wallet);
      await expect(getSessionContext()).resolves.toMatchObject({ wallet });
      expect(buildWalletMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('disposes a build that resolves after losing the timeout race', async () => {
    vi.useFakeTimers();
    try {
      const late = fakeWallet();
      const gate = deferred<Wallet>();
      buildWalletMock.mockReturnValueOnce(gate.promise);

      const timedOut = getSessionContext();
      const assertion = expect(timedOut).rejects.toThrow(/timed out/i);
      await vi.advanceTimersByTimeAsync(8_000);
      await assertion;

      gate.resolve(late);
      await vi.advanceTimersByTimeAsync(0);
      expect(late.dispose).toHaveBeenCalledOnce();
      await expect(late.getContractManager()).rejects.toThrow('LOCKED');
      await expect(late.getVtxoManager()).rejects.toThrow('LOCKED');
    } finally {
      vi.useRealTimers();
    }
  });

  it('disposes a late build after lock and does not cache it', async () => {
    const late = fakeWallet();
    const gate = deferred<Wallet>();
    buildWalletMock.mockReturnValueOnce(gate.promise);

    const building = getSessionContext();
    await vi.waitFor(() => expect(buildWalletMock).toHaveBeenCalledOnce());
    const transition = beginSessionLock();
    expect(isUnlocked()).toBe(false);
    gate.resolve(late);

    await expect(building).rejects.toThrow('LOCKED');
    await transition.disposal;
    expect(late.dispose).toHaveBeenCalledOnce();
    await expect(late.getContractManager()).rejects.toThrow('LOCKED');
    await expect(late.getVtxoManager()).rejects.toThrow('LOCKED');
  });

  it('keeps a new session build isolated from a late old build', async () => {
    const oldGate = deferred<Wallet>();
    buildWalletMock.mockReturnValueOnce(oldGate.promise);
    const oldBuild = getSessionContext();
    await vi.waitFor(() => expect(buildWalletMock).toHaveBeenCalledOnce());

    await openSession(MNEMONIC, 'regtest');
    const newGate = deferred<Wallet>();
    buildWalletMock.mockReturnValueOnce(newGate.promise);
    const newBuild = getSessionContext();
    await vi.waitFor(() => expect(buildWalletMock).toHaveBeenCalledTimes(2));

    const late = fakeWallet();
    oldGate.resolve(late);
    await expect(oldBuild).rejects.toThrow('LOCKED');

    const joiningCaller = getSessionContext();
    const current = fakeWallet();
    newGate.resolve(current);
    const contexts = await Promise.all([newBuild, joiningCaller]);
    expect(contexts.map((context) => context.wallet)).toEqual([current, current]);
    expect(buildWalletMock).toHaveBeenCalledTimes(2);
    expect(late.dispose).toHaveBeenCalledOnce();
  });

  it('replaces the wallet and identity when a new network session opens', async () => {
    const oldWallet = fakeWallet();
    await installContext(oldWallet);
    const oldIdentity = buildWalletMock.mock.calls[0][0];

    await openSession(MNEMONIC, 'mutinynet');
    expect(getSessionNetwork()).toBe('mutinynet');
    expect(oldWallet.dispose).toHaveBeenCalledOnce();

    const newWallet = fakeWallet();
    buildWalletMock.mockResolvedValueOnce(newWallet);
    await expect(getSessionContext()).resolves.toMatchObject({ wallet: newWallet });
    expect(buildWalletMock).toHaveBeenLastCalledWith(expect.any(SeedIdentity), 'mutinynet');
    expect(buildWalletMock.mock.calls[1][0]).not.toBe(oldIdentity);
  });

  it('does not retain a wallet whose disposal fails', async () => {
    const oldWallet = fakeWallet({ dispose: vi.fn(async () => Promise.reject(new Error('boom'))) });
    await installContext(oldWallet);

    await expect(invalidateSessionWallet()).resolves.toBeUndefined();
    const current = fakeWallet();
    await expect(installContext(current)).resolves.toMatchObject({ wallet: current });
  });

  it('keeps a disposed wallet dead for stale holders', async () => {
    const wallet = fakeWallet();
    const held = await installContext(wallet);

    await invalidateSessionWallet();

    await expect(held.wallet.getContractManager()).rejects.toThrow('LOCKED');
    await expect(held.wallet.getVtxoManager()).rejects.toThrow('LOCKED');
    expect(wallet.dispose).toHaveBeenCalledOnce();
  });
});

describe('ensureFreshVtxos', () => {
  it('shares one refresh between concurrent callers', async () => {
    const gate = deferred<void>();
    const refreshVtxos = vi.fn(() => gate.promise);
    const wallet = fakeWallet({ getContractManager: vi.fn(async () => ({ refreshVtxos })) });
    const context = await installContext(wallet);

    const first = ensureFreshVtxos(context);
    const second = ensureFreshVtxos(context);
    gate.resolve();
    await Promise.all([first, second]);
    expect(refreshVtxos).toHaveBeenCalledOnce();
  });

  it('uses the freshness window only within the owning session', async () => {
    const firstRefresh = vi.fn(async () => {});
    const first = fakeWallet({
      getContractManager: vi.fn(async () => ({ refreshVtxos: firstRefresh })),
    });
    const firstContext = await installContext(first);
    await ensureFreshVtxos(firstContext, 10_000);
    await ensureFreshVtxos(firstContext, 10_000);
    expect(firstRefresh).toHaveBeenCalledOnce();

    await invalidateSessionWallet();
    const secondRefresh = vi.fn(async () => {});
    const second = fakeWallet({
      getContractManager: vi.fn(async () => ({ refreshVtxos: secondRefresh })),
    });
    const secondContext = await installContext(second);
    await ensureFreshVtxos(secondContext, 10_000);
    expect(secondRefresh).toHaveBeenCalledOnce();
  });

  it('clears a failed refresh so the next call retries', async () => {
    const refreshVtxos = vi
      .fn()
      .mockRejectedValueOnce(new Error('indexer down'))
      .mockResolvedValueOnce(undefined);
    const wallet = fakeWallet({ getContractManager: vi.fn(async () => ({ refreshVtxos })) });
    const context = await installContext(wallet);

    await expect(ensureFreshVtxos(context, 0)).rejects.toThrow('indexer down');
    await expect(ensureFreshVtxos(context, 0)).resolves.toBeUndefined();
    expect(refreshVtxos).toHaveBeenCalledTimes(2);
  });

  it('clears a timed-out refresh so the next call retries', async () => {
    vi.useFakeTimers();
    try {
      const refreshVtxos = vi
        .fn()
        .mockReturnValueOnce(new Promise<void>(() => {}))
        .mockResolvedValueOnce(undefined);
      const wallet = fakeWallet({ getContractManager: vi.fn(async () => ({ refreshVtxos })) });
      const context = await installContext(wallet);

      const stuck = ensureFreshVtxos(context, 0);
      const assertion = expect(stuck).rejects.toThrow(/timed out/i);
      await vi.advanceTimersByTimeAsync(60_000);
      await assertion;
      await expect(ensureFreshVtxos(context, 0)).resolves.toBeUndefined();
      expect(refreshVtxos).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not stamp freshness when an uncancellable refresh lands after timeout', async () => {
    vi.useFakeTimers();
    try {
      const stalled = deferred<void>();
      const refreshVtxos = vi.fn().mockReturnValueOnce(stalled.promise).mockResolvedValue(undefined);
      const wallet = fakeWallet({ getContractManager: vi.fn(async () => ({ refreshVtxos })) });
      const context = await installContext(wallet);

      const stuck = ensureFreshVtxos(context);
      const assertion = expect(stuck).rejects.toThrow(/timed out/i);
      await vi.advanceTimersByTimeAsync(60_000);
      await assertion;
      stalled.resolve();
      await vi.advanceTimersByTimeAsync(0);

      await ensureFreshVtxos(context);
      expect(refreshVtxos).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not stamp freshness when a refresh outlives its session', async () => {
    const gate = deferred<void>();
    const oldWallet = fakeWallet({
      getContractManager: vi.fn(async () => ({ refreshVtxos: vi.fn(() => gate.promise) })),
    });
    const oldContext = await installContext(oldWallet);
    const inFlight = ensureFreshVtxos(oldContext, 0);
    await vi.waitFor(() => expect(oldWallet.getContractManager).toHaveBeenCalled());

    await invalidateSessionWallet();
    gate.resolve();
    await inFlight;

    const refreshVtxos = vi.fn(async () => {});
    const newWallet = fakeWallet({ getContractManager: vi.fn(async () => ({ refreshVtxos })) });
    const newContext = await installContext(newWallet);
    await ensureFreshVtxos(newContext, 10_000);
    expect(refreshVtxos).toHaveBeenCalledOnce();
  });

  it('rejects a context not owned by the current session', async () => {
    const stale = await installContext(fakeWallet());
    await invalidateSessionWallet();

    await expect(ensureFreshVtxos(stale)).rejects.toThrow('LOCKED');
  });

  it('does not refresh after invalidation while manager acquisition is pending', async () => {
    const managerGate = deferred<{ refreshVtxos: () => Promise<void> }>();
    const refreshVtxos = vi.fn(async () => {});
    const wallet = fakeWallet({ getContractManager: vi.fn(() => managerGate.promise) });
    const context = await installContext(wallet);

    const inFlight = ensureFreshVtxos(context, 0);
    await vi.waitFor(() => expect(wallet.getContractManager).toHaveBeenCalledOnce());
    await invalidateSessionWallet();
    managerGate.resolve({ refreshVtxos });

    await expect(inFlight).rejects.toThrow('LOCKED');
    expect(refreshVtxos).not.toHaveBeenCalled();
  });
});
