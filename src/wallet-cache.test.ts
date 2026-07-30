import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Cache-first read contract check. Proves the snapshot store
 * is network-scoped: a cached snapshot is only returned for the SAME network, so a
 * network switch (different operator → different addresses) never serves stale
 * addresses from the previous operator. Uses an in-memory `browser.storage.local`.
 */

// Minimal in-memory chrome.storage.local stand-in.
const store = new Map<string, unknown>();
const browserMock = {
  storage: {
    local: {
      get: vi.fn(async (key: string) => ({ [key]: store.get(key) })),
      set: vi.fn(async (items: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(items)) store.set(k, v);
      }),
    },
  },
};
// `browser` is a global in the WXT/webext runtime; provide it for the unit test.
vi.stubGlobal('browser', browserMock);

const { getSnapshot, setSnapshot } = await import('./wallet-cache');
import type { WalletSnapshot } from './wallet-cache';

const snap = (over: Partial<WalletSnapshot> = {}): WalletSnapshot => ({
  network: 'regtest',
  address: 'tark1qexample',
  boardingAddress: 'bcrt1qexample',
  balance: null,
  fetchedAt: 1_700_000_000_000,
  ...over,
});

describe('wallet-cache snapshot store', () => {
  beforeEach(() => store.clear());

  it('returns null when nothing is cached', async () => {
    expect(await getSnapshot('regtest')).toBeNull();
  });

  it('round-trips a snapshot for the same network', async () => {
    const s = snap();
    await setSnapshot(s);
    expect(await getSnapshot('regtest')).toEqual(s);
  });

  it('does NOT return a snapshot cached for a different network', async () => {
    await setSnapshot(snap({ network: 'regtest', address: 'tark1qregtest' }));
    // Switching to mutinynet must not serve the regtest operator's address.
    expect(await getSnapshot('mutinynet')).toBeNull();
  });
});
