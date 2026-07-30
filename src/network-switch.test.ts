import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NetworkName, Wallet } from '@arkade-os/sdk';

const effects = vi.hoisted(() => ({
  armAutoLock: vi.fn(async () => {}),
  clearAutoLock: vi.fn(async () => {}),
  disposeSwaps: vi.fn(async () => {}),
  emitToAllConnected: vi.fn(async (_event: string, _data?: unknown) => {}),
  lockWallet: vi.fn(async () => {}),
  rejectPendingApproval: vi.fn(async () => true),
  buildWallet: vi.fn(),
}));

vi.mock('./auto-lock', () => ({
  armAutoLock: effects.armAutoLock,
  clearAutoLock: effects.clearAutoLock,
}));
vi.mock('./lightning', () => ({ disposeSwaps: effects.disposeSwaps }));
vi.mock('./approvals', () => ({ rejectPendingApproval: effects.rejectPendingApproval }));
vi.mock('./provider-handlers', () => ({ emitToAllConnected: effects.emitToAllConnected }));
vi.mock('./session-lock', () => ({ lockWallet: effects.lockWallet }));
vi.mock('./wallet', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./wallet')>();
  return { ...actual, buildWallet: effects.buildWallet };
});

const local = new Map<string, unknown>();
const session = new Map<string, unknown>();

function readStore(store: Map<string, unknown>, keys: string | string[]) {
  const requested = Array.isArray(keys) ? keys : [keys];
  return Object.fromEntries(requested.map((key) => [key, store.get(key)]));
}

function persist(items: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(items)) local.set(key, value);
}

const localGet = vi.fn(async (keys: string | string[]) => readStore(local, keys));
const localSet = vi.fn(async (items: Record<string, unknown>) => persist(items));
const localRemove = vi.fn(async (key: string) => void local.delete(key));

vi.stubGlobal('browser', {
  storage: {
    local: { get: localGet, set: localSet, remove: localRemove },
    session: {
      get: vi.fn(async (keys: string | string[]) => readStore(session, keys)),
      set: vi.fn(async (items: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(items)) session.set(key, value);
      }),
      remove: vi.fn(async (key: string) => void session.delete(key)),
    },
  },
});

const keystore = await import('./keystore');
const crypto = await import('./crypto');
const runtime = await import('./wallet-runtime');
const { switchWalletNetwork } = await import('./network-switch');

const PASSWORD = 'correct horse battery staple';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeWallet(): Wallet {
  return {
    dispose: vi.fn(async () => {}),
    getContractManager: vi.fn(async () => ({})),
    getVtxoManager: vi.fn(async () => ({})),
  } as unknown as Wallet;
}

function resetEffects(): void {
  effects.armAutoLock.mockReset().mockResolvedValue(undefined);
  effects.clearAutoLock.mockReset().mockResolvedValue(undefined);
  effects.disposeSwaps.mockReset().mockResolvedValue(undefined);
  effects.emitToAllConnected.mockReset().mockResolvedValue(undefined);
  effects.lockWallet.mockReset().mockImplementation(async () => {
    await runtime.beginSessionLock().disposal;
  });
  effects.rejectPendingApproval.mockReset().mockResolvedValue(true);
  effects.buildWallet.mockReset();
  localGet.mockClear();
  localSet.mockReset().mockImplementation(async (items) => persist(items));
  localRemove.mockClear();
}

async function createUnlockedWallet(): Promise<string> {
  const mnemonic = await keystore.createWallet(PASSWORD);
  resetEffects();
  return mnemonic;
}

beforeEach(async () => {
  await runtime.beginSessionLock().disposal;
  local.clear();
  session.clear();
  resetEffects();
});

describe('switchWalletNetwork', () => {
  it('leaves the live session and durable state untouched on a wrong password', async () => {
    await createUnlockedWallet();
    const vaultBefore = local.get('vault');
    const versionBefore = runtime.getRuntimeVersion();

    await expect(switchWalletNetwork('mutinynet', 'wrong-password')).rejects.toThrow();

    expect(local.get('vault')).toEqual(vaultBefore);
    expect(local.get('network')).toBeUndefined();
    expect(runtime.getRuntimeVersion()).toEqual(versionBefore);
    expect(runtime.isUnlocked()).toBe(true);
    expect(effects.disposeSwaps).not.toHaveBeenCalled();
    expect(effects.rejectPendingApproval).not.toHaveBeenCalled();
    expect(effects.clearAutoLock).not.toHaveBeenCalled();
    expect(effects.emitToAllConnected).not.toHaveBeenCalled();
  });

  it('does nothing when the target network is already active', async () => {
    await createUnlockedWallet();
    const vaultBefore = local.get('vault');
    const versionBefore = runtime.getRuntimeVersion();

    await expect(switchWalletNetwork('regtest', PASSWORD)).resolves.toBe(false);

    expect(local.get('vault')).toEqual(vaultBefore);
    expect(local.get('network')).toBeUndefined();
    expect(runtime.getRuntimeVersion()).toEqual(versionBefore);
    expect(localSet).not.toHaveBeenCalled();
    expect(effects.disposeSwaps).not.toHaveBeenCalled();
    expect(effects.emitToAllConnected).not.toHaveBeenCalled();
  });

  it('atomically switches an unlocked session and keeps wallet construction lazy', async () => {
    const mnemonic = await createUnlockedWallet();
    local.set('walletSnapshot', { network: 'regtest', address: 'stale' });

    await expect(switchWalletNetwork('mutinynet', PASSWORD)).resolves.toBe(true);

    expect(local.get('network')).toBe('mutinynet');
    expect(local.get('walletSnapshot')).toBeNull();
    expect(runtime.isUnlocked()).toBe(true);
    expect(runtime.getSessionNetwork()).toBe('mutinynet');
    expect(effects.buildWallet).not.toHaveBeenCalled();
    expect(effects.disposeSwaps).toHaveBeenCalledOnce();
    expect(effects.rejectPendingApproval).toHaveBeenCalledWith('Wallet network changed.');
    expect(effects.clearAutoLock).toHaveBeenCalledOnce();
    expect(effects.armAutoLock).toHaveBeenCalledOnce();
    expect(effects.emitToAllConnected).toHaveBeenCalledWith('networkChanged', {
      network: 'mutinynet',
    });
    expect(
      await crypto.decryptVault(
        local.get('vault') as Parameters<typeof crypto.decryptVault>[0],
        PASSWORD,
        'mutinynet',
      ),
    ).toBe(mnemonic);
  });

  it('switches durable state while keeping a locked wallet locked', async () => {
    await createUnlockedWallet();
    await runtime.beginSessionLock().disposal;
    resetEffects();

    await expect(switchWalletNetwork('mutinynet', PASSWORD)).resolves.toBe(true);

    expect(local.get('network')).toBe('mutinynet');
    expect(runtime.isUnlocked()).toBe(false);
    expect(effects.armAutoLock).not.toHaveBeenCalled();
    expect(effects.disposeSwaps).toHaveBeenCalledOnce();
    expect(effects.emitToAllConnected).toHaveBeenCalledWith('networkChanged', {
      network: 'mutinynet',
    });
  });

  it('fails locked if the new session cannot obtain an auto-lock deadline', async () => {
    await createUnlockedWallet();
    effects.armAutoLock.mockRejectedValueOnce(new Error('alarms unavailable'));

    await expect(switchWalletNetwork('mutinynet', PASSWORD)).rejects.toThrow(
      'alarms unavailable',
    );

    expect(local.get('network')).toBe('mutinynet');
    expect(runtime.isUnlocked()).toBe(false);
    expect(effects.lockWallet).toHaveBeenCalledWith('idle');
    expect(effects.emitToAllConnected).toHaveBeenCalledWith('networkChanged', {
      network: 'mutinynet',
    });
  });

  it('does not roll back a durable switch when best-effort cleanup fails', async () => {
    await createUnlockedWallet();
    effects.disposeSwaps.mockRejectedValueOnce(new Error('swap cleanup failed'));

    await expect(switchWalletNetwork('mutinynet', PASSWORD)).resolves.toBe(true);

    expect(local.get('network')).toBe('mutinynet');
    expect(runtime.isUnlocked()).toBe(true);
    expect(runtime.getSessionNetwork()).toBe('mutinynet');
    expect(effects.emitToAllConnected).toHaveBeenCalledWith('networkChanged', {
      network: 'mutinynet',
    });
  });

  it('fails closed and stays locked when the durable write fails', async () => {
    await createUnlockedWallet();
    const vaultBefore = local.get('vault');
    const snapshotBefore = { network: 'regtest', address: 'cached' };
    local.set('walletSnapshot', snapshotBefore);
    localSet.mockRejectedValueOnce(new Error('storage unavailable'));

    await expect(switchWalletNetwork('mutinynet', PASSWORD)).rejects.toThrow(
      'storage unavailable',
    );

    expect(local.get('vault')).toEqual(vaultBefore);
    expect(local.get('network')).toBeUndefined();
    expect(local.get('walletSnapshot')).toEqual(snapshotBefore);
    expect(runtime.isUnlocked()).toBe(false);
    expect(effects.disposeSwaps).toHaveBeenCalledOnce();
    expect(effects.clearAutoLock).toHaveBeenCalledOnce();
    expect(effects.armAutoLock).not.toHaveBeenCalled();
    expect(effects.emitToAllConnected).toHaveBeenCalledWith('disconnect', undefined);
    expect(effects.emitToAllConnected).not.toHaveBeenCalledWith(
      'networkChanged',
      expect.anything(),
    );
  });

  it('starts Lightning disposal before invoking the durable write', async () => {
    await createUnlockedWallet();
    const order: string[] = [];
    effects.disposeSwaps.mockImplementationOnce(async () => void order.push('dispose'));
    localSet.mockImplementationOnce(async (items) => {
      order.push('write');
      persist(items);
    });

    await switchWalletNetwork('mutinynet', PASSWORD);

    expect(order).toEqual(['dispose', 'write']);
  });

  it('keeps unlock fenced after a lock lands during the durable write', async () => {
    await createUnlockedWallet();
    const writeStarted = deferred<void>();
    const releaseWrite = deferred<void>();
    localSet.mockImplementationOnce(async (items) => {
      writeStarted.resolve();
      await releaseWrite.promise;
      persist(items);
    });

    const switching = switchWalletNetwork('mutinynet', PASSWORD);
    await writeStarted.promise;
    expect(runtime.isUnlocked()).toBe(false);

    const locking = runtime.beginSessionLock();
    expect(locking.didLock).toBe(true);
    await locking.disposal;
    expect(runtime.beginSessionLock().didLock).toBe(false);
    await expect(keystore.unlock(PASSWORD)).rejects.toThrow('NETWORK_TRANSITION');

    releaseWrite.resolve();
    await expect(switching).resolves.toBe(true);

    expect(local.get('network')).toBe('mutinynet');
    expect(runtime.isUnlocked()).toBe(false);
    expect(effects.armAutoLock).not.toHaveBeenCalled();
    expect(effects.emitToAllConnected.mock.calls.map(([event]) => event)).toEqual([
      'networkChanged',
    ]);
  });

  it('blocks an old-network unlock while the durable write is in flight', async () => {
    await createUnlockedWallet();
    const writeStarted = deferred<void>();
    const releaseWrite = deferred<void>();
    localSet.mockImplementationOnce(async (items) => {
      writeStarted.resolve();
      await releaseWrite.promise;
      persist(items);
    });

    const switching = switchWalletNetwork('mutinynet', PASSWORD);
    await writeStarted.promise;

    await expect(keystore.unlock(PASSWORD)).rejects.toThrow('NETWORK_TRANSITION');
    expect(runtime.isUnlocked()).toBe(false);
    releaseWrite.resolve();
    await expect(switching).resolves.toBe(true);

    expect(local.get('network')).toBe('mutinynet');
    expect(runtime.isUnlocked()).toBe(true);
    expect(runtime.getSessionNetwork()).toBe('mutinynet');
  });

  it('serializes concurrent switches through preparation, writes, and events', async () => {
    await createUnlockedWallet();
    const writes: NetworkName[] = [];
    localSet.mockImplementation(async (items) => {
      if (items.network) writes.push(items.network as NetworkName);
      persist(items);
    });

    const first = switchWalletNetwork('mutinynet', PASSWORD);
    const second = switchWalletNetwork('bitcoin', PASSWORD);

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(writes).toEqual(['mutinynet', 'bitcoin']);
    expect(
      effects.emitToAllConnected.mock.calls
        .filter(([event]) => event === 'networkChanged')
        .map(([, data]) => (data as { network: NetworkName }).network),
    ).toEqual(['mutinynet', 'bitcoin']);
    expect(local.get('network')).toBe('bitcoin');
    expect(runtime.getSessionNetwork()).toBe('bitcoin');
  });

  it('continues the serialized queue after a failed switch', async () => {
    await createUnlockedWallet();

    const failed = switchWalletNetwork('mutinynet', 'wrong-password');
    const recovered = switchWalletNetwork('mutinynet', PASSWORD);

    await Promise.all([
      expect(failed).rejects.toThrow(),
      expect(recovered).resolves.toBe(true),
    ]);
    expect(local.get('network')).toBe('mutinynet');
    expect(runtime.getSessionNetwork()).toBe('mutinynet');
    expect(effects.emitToAllConnected).toHaveBeenCalledTimes(1);
  });

  it('disposes a wallet build that resolves after the switch fence', async () => {
    await createUnlockedWallet();
    const build = deferred<Wallet>();
    const lateWallet = fakeWallet();
    effects.buildWallet.mockReturnValueOnce(build.promise);
    const acquiring = runtime.getSessionContext();
    const assertion = expect(acquiring).rejects.toThrow('LOCKED');
    await vi.waitFor(() => expect(effects.buildWallet).toHaveBeenCalledOnce());

    await switchWalletNetwork('mutinynet', PASSWORD);
    build.resolve(lateWallet);
    await assertion;

    expect(lateWallet.dispose).toHaveBeenCalledOnce();
    expect(runtime.isUnlocked()).toBe(true);
    expect(runtime.getSessionNetwork()).toBe('mutinynet');
  });
});
