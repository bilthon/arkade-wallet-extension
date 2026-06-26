import { describe, it, expect, beforeEach, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import type { MessageSenderLike } from './origin';

/**
 * Dapp-handler gating (Track E2a, M4). The end-to-end origin + grant contract the SW
 * exposes to a dapp:
 *   • a https origin can connect (approval) and then read; an http/null origin is
 *     rejected with BAD_ORIGIN and can never connect.
 *   • a granted read method is allowed; an ungranted one is NOT_CONNECTED; post-revoke
 *     it is NOT_CONNECTED again.
 *   • a body-supplied origin can't widen access (only the sender is consulted).
 *   • a locked wallet yields LOCKED on reads.
 * Backed by in-memory storage; the approval window-opener is faked to auto-resolve.
 */

const local = new Map<string, unknown>();
const session = new Map<string, unknown>();
let createdWindowId = 100;

const tabsSent: unknown[] = [];
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
  runtime: { getURL: (p: string) => `chrome-extension://test${p}` },
  windows: {
    create: vi.fn(async () => ({ id: ++createdWindowId })),
    onRemoved: { addListener: vi.fn() },
  },
  tabs: {
    query: vi.fn(async () => [{ id: 1, url: 'https://dapp.example/page' }]),
    sendMessage: vi.fn(async (_id: number, msg: unknown) => void tabsSent.push(msg)),
  },
};
vi.stubGlobal('browser', browserMock);
if (!globalThis.crypto) vi.stubGlobal('crypto', webcrypto);

// hasVault/getNetwork read storage (set in beforeEach). isUnlocked is the lock gate —
// mock keystore so we control lock state without a real seed.
let unlocked = true;
vi.mock('./keystore', async () => {
  const actual = await vi.importActual<typeof import('./keystore')>('./keystore');
  return { ...actual, isUnlocked: () => unlocked };
});
// networkConfig is pure but imports the SDK; stub to avoid pulling SDK into the test.
vi.mock('./wallet', () => ({
  networkConfig: () => ({ arkServerUrl: 'http://localhost:7070', esploraUrl: '', isMainnet: false }),
}));

import {
  handleConnect,
  handleDisconnect,
  handleIsConnected,
  handleGetAccounts,
  requireRead,
  revokeSite,
  resolveApproval,
} from './dapp-handlers';
import { setVault, setNetwork } from './storage';
import { isMethodGranted } from './permissions';
import { decodeProviderError } from './provider-api';

function sender(partial: MessageSenderLike): MessageSenderLike {
  return partial;
}

const HTTPS = sender({ origin: 'https://dapp.example' });

/** A fake read-only wallet returning a deterministic Arkade address. */
const fakeWallet = () =>
  Promise.resolve({
    getAddress: async () => 'tark1theaccount',
    getBoardingAddress: async () => 'bcrt1boarding',
    getBalance: async () => ({ available: 0 }),
    getPublicKey: async () => ({ xOnly: 'aa', compressed: 'bb' }),
  });

/** Drive a connect to approval, auto-approving via resolveApproval. */
async function connectApproving(s: MessageSenderLike) {
  const promise = handleConnect(s, fakeWallet);
  // Let requestApproval persist + open the window, then approve.
  for (let i = 0; i < 6; i++) await Promise.resolve();
  const pending = session.get('pendingApproval') as { requestId: string } | undefined;
  if (pending) await resolveApproval(pending.requestId, { approved: true });
  return promise;
}

function codeOf(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  return decodeProviderError(err.message)?.code ?? null;
}

beforeEach(async () => {
  local.clear();
  session.clear();
  tabsSent.length = 0;
  unlocked = true;
  browserMock.windows.create.mockClear();
  browserMock.tabs.sendMessage.mockClear();
  await setVault({ v: 1 } as never); // hasVault() → true
  await setNetwork('regtest');
});

describe('handleConnect — origin gating (M4)', () => {
  it('rejects an http (non-loopback) origin with BAD_ORIGIN before any approval', async () => {
    await expect(
      handleConnect(sender({ origin: 'http://dapp.example' }), fakeWallet),
    ).rejects.toSatisfy((e: unknown) => codeOf(e) === 'BAD_ORIGIN');
    expect(browserMock.windows.create).not.toHaveBeenCalled();
  });

  it('rejects a null/opaque origin with BAD_ORIGIN', async () => {
    await expect(
      handleConnect(sender({ origin: 'null' }), fakeWallet),
    ).rejects.toSatisfy((e: unknown) => codeOf(e) === 'BAD_ORIGIN');
  });

  it('ignores a body-supplied origin — only the sender is consulted', async () => {
    // handleConnect has no body parameter; a malicious page cannot pass an origin.
    // Connecting from the real sender grants the real origin, never an attacker label.
    const accounts = await connectApproving(HTTPS);
    expect(accounts).toEqual({ accounts: ['tark1theaccount'] });
    expect(await isMethodGranted('https://dapp.example', 'getBalance')).toBe(true);
    expect(await isMethodGranted('https://bank.example', 'getBalance')).toBe(false);
  });
});

describe('handleConnect — approval + grant', () => {
  it('opens the approval window and grants read-only on approve', async () => {
    browserMock.windows.create.mockClear();
    const accounts = await connectApproving(HTTPS);
    expect(accounts.accounts).toEqual(['tark1theaccount']);
    expect(browserMock.windows.create).toHaveBeenCalledOnce();
    // Read-only: no signing method granted.
    expect(await isMethodGranted('https://dapp.example', 'getBalance')).toBe(true);
    expect(await isMethodGranted('https://dapp.example', 'signPsbt')).toBe(false);
  });

  it('rejects with REJECTED when the user declines', async () => {
    const promise = handleConnect(HTTPS, fakeWallet);
    for (let i = 0; i < 6; i++) await Promise.resolve();
    const pending = session.get('pendingApproval') as { requestId: string };
    await resolveApproval(pending.requestId, { approved: false });
    await expect(promise).rejects.toSatisfy((e: unknown) => codeOf(e) === 'REJECTED');
  });

  it('is idempotent — a second connect from an already-granted origin does not re-prompt', async () => {
    await connectApproving(HTTPS);
    browserMock.windows.create.mockClear();
    const again = await handleConnect(HTTPS, fakeWallet);
    expect(again.accounts).toEqual(['tark1theaccount']);
    expect(browserMock.windows.create).not.toHaveBeenCalled();
  });

  it('throws LOCKED when the wallet is locked at connect time', async () => {
    unlocked = false;
    await expect(handleConnect(HTTPS, fakeWallet)).rejects.toSatisfy(
      (e: unknown) => codeOf(e) === 'LOCKED',
    );
  });
});

describe('requireRead — grant + lock gate', () => {
  it('allows a granted method and rejects an ungranted method', async () => {
    await connectApproving(HTTPS);
    await expect(requireRead(HTTPS, 'getBalance')).resolves.toBe('https://dapp.example');
    // getBalance is granted; a never-granted origin is NOT_CONNECTED.
    await expect(
      requireRead(sender({ origin: 'https://other.example' }), 'getBalance'),
    ).rejects.toSatisfy((e: unknown) => codeOf(e) === 'NOT_CONNECTED');
  });

  it('rejects reads with LOCKED when the wallet is locked', async () => {
    await connectApproving(HTTPS);
    unlocked = false;
    await expect(requireRead(HTTPS, 'getBalance')).rejects.toSatisfy(
      (e: unknown) => codeOf(e) === 'LOCKED',
    );
  });
});

describe('disconnect / revoke', () => {
  it('disconnect revokes the grant and emits a disconnect event to the origin', async () => {
    await connectApproving(HTTPS);
    expect(await isMethodGranted('https://dapp.example', 'getBalance')).toBe(true);

    await handleDisconnect(HTTPS);

    expect(await isMethodGranted('https://dapp.example', 'getBalance')).toBe(false);
    expect((await handleIsConnected(HTTPS)).connected).toBe(false);
    // A disconnect event was pushed to the matching tab.
    expect(tabsSent.some((m) => (m as { event?: string }).event === 'disconnect')).toBe(true);
  });

  it('revokeSite (from Settings) revokes and reads then fail NOT_CONNECTED', async () => {
    await connectApproving(HTTPS);
    await revokeSite('https://dapp.example');
    await expect(requireRead(HTTPS, 'getBalance')).rejects.toSatisfy(
      (e: unknown) => codeOf(e) === 'NOT_CONNECTED',
    );
  });
});

describe('soft reads', () => {
  it('getAccounts returns [] for an unconnected origin (no throw)', async () => {
    expect(await handleGetAccounts(HTTPS)).toEqual({ accounts: [] });
  });

  it('isConnected returns false for an opaque origin without throwing', async () => {
    expect(await handleIsConnected(sender({ origin: 'null' }))).toEqual({ connected: false });
  });
});
