import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Keystore handler-logic round-trip (the message handlers are thin wrappers over
 * these functions). Proves the boundary end-to-end against an in-memory
 * `browser.storage`/`alarms`:
 *   create → runtime unlocked + encrypted vault persisted, no session hint
 *   lock   → runtime capability revoked while the encrypted vault remains
 *   getMnemonicForBackup re-auths from the vault (wrong password rejected)
 * This is the security-critical contract the background `onMessage` handlers expose.
 */

const local = new Map<string, unknown>();
const session = new Map<string, unknown>();

const browserMock = {
  storage: {
    local: {
      get: vi.fn(async (keys: string | string[]) => {
        const requested = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(requested.map((key) => [key, local.get(key)]));
      }),
      set: vi.fn(async (items: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(items)) local.set(k, v);
      }),
      remove: vi.fn(async (key: string) => void local.delete(key)),
    },
    session: {
      get: vi.fn(async (key: string) => ({ [key]: session.get(key) })),
      set: vi.fn(async (items: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(items)) session.set(k, v);
      }),
      remove: vi.fn(async (key: string) => void session.delete(key)),
    },
  },
};
vi.stubGlobal('browser', browserMock);

const keystore = await import('./keystore');
const crypto = await import('./crypto');
const runtime = await import('./wallet-runtime');

const PASSWORD = 'correct horse battery staple';

async function resetRuntime(): Promise<void> {
  await runtime.beginSessionLock().disposal;
}

describe('keystore handler round-trip (boundary)', () => {
  beforeEach(async () => {
    local.clear();
    session.clear();
    await resetRuntime();
  });

  it('create → runtime unlocked, vault persisted, nothing written to session storage', async () => {
    expect(await keystore.getLockState()).toEqual({ hasVault: false, unlocked: false });

    const mnemonic = await keystore.createWallet(PASSWORD);
    expect(mnemonic.split(/\s+/).length).toBe(12);

    // The runtime owns unlock state; the encrypted mnemonic is persisted locally.
    expect(await keystore.getLockState()).toEqual({ hasVault: true, unlocked: true });
    expect(runtime.isUnlocked()).toBe(true);
    expect(local.get('vault')).toBeTruthy();

    expect([...session.entries()]).toEqual([]);
  });

  it('lock revokes the runtime wallet while retaining the encrypted vault', async () => {
    await keystore.createWallet(PASSWORD);
    await resetRuntime();
    expect(runtime.isUnlocked()).toBe(false);
    await expect(runtime.getSessionContext()).rejects.toThrow('LOCKED');
    expect([...session.entries()]).toEqual([]);
    // Vault stays at rest so the wallet can be unlocked again.
    expect(local.get('vault')).toBeTruthy();
  });

  it('imports and unlocks without persisting an unlock hint', async () => {
    const mnemonic = crypto.generateMnemonic();
    await keystore.importWallet(mnemonic, PASSWORD);
    expect(runtime.isUnlocked()).toBe(true);
    expect([...session.entries()]).toEqual([]);

    await resetRuntime();
    await keystore.unlock(PASSWORD);
    expect(runtime.isUnlocked()).toBe(true);
    expect([...session.entries()]).toEqual([]);
  });

  it('reauthenticates without replacing an already-live session', async () => {
    await keystore.createWallet(PASSWORD);
    const epoch = runtime.getSessionEpoch();

    await expect(keystore.unlock('wrong-password')).rejects.toThrow();
    await keystore.unlock(PASSWORD);

    expect(runtime.getSessionEpoch()).toBe(epoch);
    expect(runtime.getSessionNetwork()).toBe('regtest');
  });

  it('getMnemonicForBackup re-auths from the vault', async () => {
    const created = await keystore.createWallet(PASSWORD);
    await expect(keystore.getMnemonicForBackup('wrong-password')).rejects.toThrow();
    expect(await keystore.getMnemonicForBackup(PASSWORD)).toBe(created);
  });
});

describe('prepareNetworkSwitch', () => {
  // Reuse the same browser mock (local/session) declared above; cleared before each case.
  beforeEach(async () => {
    local.clear();
    session.clear();
    await resetRuntime();
  });

  it('stages a target-network vault without changing durable or runtime state', async () => {
    const mnemonic = await keystore.createWallet(PASSWORD);
    const vaultBefore = local.get('vault');
    const epochBefore = runtime.getSessionEpoch();

    const prepared = await keystore.prepareNetworkSwitch('mutinynet', PASSWORD);

    expect(prepared).toMatchObject({
      sourceNetwork: 'regtest',
      targetNetwork: 'mutinynet',
    });
    expect(await crypto.decryptVault(prepared!.vault, PASSWORD, 'mutinynet')).toBe(mnemonic);
    await expect(crypto.decryptVault(prepared!.vault, PASSWORD, 'regtest')).rejects.toThrow();
    expect(local.get('vault')).toEqual(vaultBefore);
    expect(local.get('network')).toBeUndefined();
    expect(runtime.getSessionEpoch()).toBe(epochBefore);
    expect(runtime.getSessionNetwork()).toBe('regtest');
  });

  it('wrong password leaves vault + network unchanged', async () => {
    await keystore.createWallet(PASSWORD);
    const vaultBefore = local.get('vault');

    await expect(
      keystore.prepareNetworkSwitch('mutinynet', 'wrong-password'),
    ).rejects.toThrow();

    // Network unchanged (still regtest/default).
    expect(local.get('network')).toBeUndefined(); // never set → default regtest
    // Vault blob is identical.
    expect(local.get('vault')).toEqual(vaultBefore);
    // Still decryptable under the original network.
    await expect(keystore.getMnemonicForBackup(PASSWORD)).resolves.toBeTruthy();
    expect(runtime.isUnlocked()).toBe(true);
    expect(runtime.getSessionNetwork()).toBe('regtest');
  });

  it('same-network target is a no-op (vault unchanged)', async () => {
    await keystore.createWallet(PASSWORD);
    const vaultBefore = local.get('vault');

    // regtest is the default; switching to it again is a no-op.
    expect(await keystore.prepareNetworkSwitch('regtest', PASSWORD)).toBeNull();

    expect(local.get('vault')).toEqual(vaultBefore);
    expect(local.get('network')).toBeUndefined(); // setNetwork was never called
  });

  it('preparing changes nothing until the coordinator commits it', async () => {
    await keystore.createWallet(PASSWORD);
    const vaultBefore = local.get('vault');
    const epochBefore = runtime.getSessionEpoch();

    const prepared = await keystore.prepareNetworkSwitch('mutinynet', PASSWORD);
    expect(prepared).not.toBeNull();
    expect(local.get('vault')).toEqual(vaultBefore);
    expect(local.get('network')).toBeUndefined();
    expect(runtime.getSessionEpoch()).toBe(epochBefore);
    expect(runtime.getSessionNetwork()).toBe('regtest');
  });
});
