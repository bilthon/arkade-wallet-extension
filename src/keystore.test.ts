import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Keystore handler-logic round-trip (team-lead brief #2 — the message handlers are
 * thin wrappers over these functions). Proves the M1 boundary end-to-end against an
 * in-memory `browser.storage`/`alarms`:
 *   create → unlocked + vault persisted + seed NEVER in session
 *   lock   → locked + session cleared
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

const PASSWORD = 'correct horse battery staple';

describe('keystore handler round-trip (M1 boundary)', () => {
  beforeEach(async () => {
    local.clear();
    session.clear();
    await keystore.lock(); // ensure clean in-memory state between cases
  });

  it('create → unlocked, vault persisted, seed never in session', async () => {
    expect(await keystore.getLockState()).toEqual({ hasVault: false, unlocked: false });

    const mnemonic = await keystore.createWallet(PASSWORD);
    expect(mnemonic.split(/\s+/).length).toBe(12);

    // Unlocked in memory; vault persisted to local.
    expect(await keystore.getLockState()).toEqual({ hasVault: true, unlocked: true });
    expect(local.get('vault')).toBeTruthy();

    // M1: the only thing in session is the unlock flag — never the seed/mnemonic.
    const sessionDump = JSON.stringify([...session.entries()]);
    expect(sessionDump).not.toContain(mnemonic);
    expect(sessionDump).not.toContain(mnemonic.split(/\s+/)[0]);
    expect(session.get('unlocked')).toBe(true);
  });

  it('lock clears the in-memory seed and the session flag', async () => {
    await keystore.createWallet(PASSWORD);
    await keystore.lock();
    expect(keystore.isUnlocked()).toBe(false);
    expect(keystore.getUnlockedSeed()).toBeNull();
    expect(session.get('unlocked')).toBeUndefined();
    // Vault stays at rest so the wallet can be unlocked again.
    expect(local.get('vault')).toBeTruthy();
  });

  it('getMnemonicForBackup re-auths from the vault', async () => {
    const created = await keystore.createWallet(PASSWORD);
    await expect(keystore.getMnemonicForBackup('wrong-password')).rejects.toThrow();
    expect(await keystore.getMnemonicForBackup(PASSWORD)).toBe(created);
  });
});
