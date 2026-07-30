import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Per-origin scoped-grant logic. Pins: connect grants READ methods only,
 * a granted read method is allowed, an ungranted method (e.g. a signing method) is
 * rejected, and revocation immediately removes access. Backed by an in-memory
 * `browser.storage.local` (same pattern as keystore.test).
 */

const local = new Map<string, unknown>();

const browserMock = {
  storage: {
    local: {
      get: vi.fn(async (key: string) => ({ [key]: local.get(key) })),
      set: vi.fn(async (items: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(items)) local.set(k, v);
      }),
      remove: vi.fn(async (key: string) => void local.delete(key)),
    },
  },
};

vi.stubGlobal('browser', browserMock);

import {
  grantConnect,
  revokeGrant,
  revokeGrantIfCurrent,
  getGrant,
  listGrants,
  isConnected,
  isMethodGranted,
  READ_METHODS,
} from './permissions';

beforeEach(() => {
  local.clear();
});

describe('grantConnect', () => {
  it('grants exactly the READ methods and records accounts + timestamp', async () => {
    const grant = await grantConnect('https://site.example', ['tark1abc']);
    expect(grant.origin).toBe('https://site.example');
    expect(grant.accounts).toEqual(['tark1abc']);
    expect(grant.grantedMethods).toEqual([...READ_METHODS]);
    expect(grant.grantedAt).toBeGreaterThan(0);
  });

  it('does not grant any signing/sending method', async () => {
    await grantConnect('https://site.example', ['tark1abc']);
    expect(await isMethodGranted('https://site.example', 'signPsbt')).toBe(false);
    expect(await isMethodGranted('https://site.example', 'signMessage')).toBe(false);
    expect(await isMethodGranted('https://site.example', 'sendBitcoin')).toBe(false);
  });

  it('allows a granted read method', async () => {
    await grantConnect('https://site.example', ['tark1abc']);
    expect(await isMethodGranted('https://site.example', 'getBalance')).toBe(true);
    expect(await isMethodGranted('https://site.example', 'getPublicKey')).toBe(true);
  });

  it('re-connect overwrites accounts for the same origin', async () => {
    await grantConnect('https://site.example', ['tark1old']);
    await grantConnect('https://site.example', ['tark1new']);
    const grant = await getGrant('https://site.example');
    expect(grant?.accounts).toEqual(['tark1new']);
    expect((await listGrants()).length).toBe(1);
  });
});

describe('grant scoping by origin', () => {
  it('one origin grant does not leak to another origin', async () => {
    await grantConnect('https://a.example', ['tark1a']);
    expect(await isConnected('https://a.example')).toBe(true);
    expect(await isConnected('https://b.example')).toBe(false);
    expect(await isMethodGranted('https://b.example', 'getBalance')).toBe(false);
  });
});

describe('revokeGrant', () => {
  it('rejects all methods after revocation', async () => {
    await grantConnect('https://site.example', ['tark1abc']);
    expect(await isMethodGranted('https://site.example', 'getBalance')).toBe(true);

    await revokeGrant('https://site.example');

    expect(await isConnected('https://site.example')).toBe(false);
    expect(await getGrant('https://site.example')).toBeNull();
    expect(await isMethodGranted('https://site.example', 'getBalance')).toBe(false);
  });

  it('is a no-op for an unknown origin', async () => {
    await expect(revokeGrant('https://never.example')).resolves.toBeUndefined();
  });

  it('conditionally revokes only the exact grant issuance', async () => {
    const old = await grantConnect('https://site.example', ['tark1old']);
    const current = await grantConnect('https://site.example', ['tark1new']);

    await expect(revokeGrantIfCurrent(old.origin, old.id)).resolves.toBe(false);
    expect((await getGrant(old.origin))?.accounts).toEqual(['tark1new']);

    await expect(revokeGrantIfCurrent(current.origin, current.id)).resolves.toBe(true);
    expect(await getGrant(current.origin)).toBeNull();
  });
});

describe('ungranted origin', () => {
  it('rejects methods for an origin that never connected', async () => {
    expect(await isMethodGranted('https://stranger.example', 'getAddress')).toBe(false);
    expect(await isConnected('https://stranger.example')).toBe(false);
  });
});
