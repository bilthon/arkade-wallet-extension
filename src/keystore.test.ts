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
      get: vi.fn(async (key: string) => ({ [key]: local.get(key) })),
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
  alarms: {
    create: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
    onAlarm: { addListener: vi.fn() },
  },
};
vi.stubGlobal('browser', browserMock);

const keystore = await import('./keystore');
const crypto = await import('./crypto');
const runtime = await import('./wallet-runtime');

const PASSWORD = 'correct horse battery staple';

describe('keystore handler round-trip (boundary)', () => {
  beforeEach(async () => {
    local.clear();
    session.clear();
    await keystore.lock(); // ensure clean in-memory state between cases
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
    await keystore.lock();
    expect(runtime.isUnlocked()).toBe(false);
    await expect(runtime.getSessionWallet()).rejects.toThrow('LOCKED');
    expect([...session.entries()]).toEqual([]);
    // Vault stays at rest so the wallet can be unlocked again.
    expect(local.get('vault')).toBeTruthy();
  });

  it('imports and unlocks without persisting an unlock hint', async () => {
    const mnemonic = crypto.generateMnemonic();
    await keystore.importWallet(mnemonic, PASSWORD);
    expect(runtime.isUnlocked()).toBe(true);
    expect([...session.entries()]).toEqual([]);

    await keystore.lock();
    await keystore.unlock(PASSWORD);
    expect(runtime.isUnlocked()).toBe(true);
    expect([...session.entries()]).toEqual([]);
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
    await keystore.lock();
  });

  it('switches network: vault decryptable under new network, stored network updated', async () => {
    // Create under default (regtest).
    await keystore.createWallet(PASSWORD);

    // Switch to mutinynet.
    const prepared = await keystore.prepareNetworkSwitch('mutinynet', PASSWORD);
    // Mirror the background's interim switch choreography: drop the SDK wallet before
    // committing, while retaining the runtime identity so an unlocked switch stays unlocked.
    await runtime.invalidateSessionWallet();
    await prepared!.commit();

    // The stored network flips.
    expect(local.get('network')).toBe('mutinynet');

    // unlock succeeds under the new network (vault was re-encrypted under mutinynet AAD).
    await keystore.lock();
    await expect(keystore.unlock(PASSWORD)).resolves.not.toThrow();
    expect(runtime.isUnlocked()).toBe(true);
    expect(runtime.getSessionNetwork()).toBe('mutinynet');

    // …and the vault NO LONGER decrypts under the OLD network's AAD — proves the switch
    // actually re-encrypted (rebound the AAD), not just flipped the stored network pointer.
    await expect(
      crypto.decryptVault(
        local.get('vault') as Parameters<typeof crypto.decryptVault>[0],
        PASSWORD,
        'regtest',
      ),
    ).rejects.toThrow();
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

  it('preparing changes nothing until commit runs', async () => {
    // This is what keeps a wrong password from tearing down the session wallet and
    // the Lightning swap runtime: the caller only drops those once preparing has
    // succeeded, so a typo leaves a running swap alone.
    await keystore.createWallet(PASSWORD);
    const vaultBefore = local.get('vault');

    const prepared = await keystore.prepareNetworkSwitch('mutinynet', PASSWORD);
    expect(prepared).not.toBeNull();

    // Password already proven, but nothing is stored yet.
    expect(local.get('vault')).toEqual(vaultBefore);
    expect(local.get('network')).toBeUndefined();

    await prepared!.commit();
    expect(local.get('network')).toBe('mutinynet');
    expect(local.get('vault')).not.toEqual(vaultBefore);
    expect(runtime.isUnlocked()).toBe(true);
    expect(runtime.getSessionNetwork()).toBe('mutinynet');
  });

  it('does not reopen a prepared switch after the user locks', async () => {
    await keystore.createWallet(PASSWORD);
    const prepared = await keystore.prepareNetworkSwitch('mutinynet', PASSWORD);

    await keystore.lock();
    await prepared!.commit();

    expect(runtime.isUnlocked()).toBe(false);
    expect(local.get('network')).toBe('mutinynet');
  });
});
