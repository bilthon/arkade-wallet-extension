import { describe, it, expect, beforeEach, vi } from 'vitest';
import { webcrypto } from 'node:crypto';

/**
 * Approval-window orchestration. Pins the request/response resolution
 * contract that backs the connect flow:
 *   • requestApproval opens a window and returns a promise
 *   • resolveApproval(approved) settles that promise
 *   • a SECOND concurrent request is rejected (one window at a time)
 *   • a stale/mismatched requestId does not resolve
 *   • revoke/close rejects the pending request from that origin
 * Backed by an in-memory `browser.storage.session`.
 */

const session = new Map<string, unknown>();
const browserMock = {
  storage: {
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
// crypto.randomUUID for the SW-side request id.
if (!globalThis.crypto) vi.stubGlobal('crypto', webcrypto);

import {
  requestApproval,
  resolveApproval,
  rejectApprovalForOrigin,
  rejectPendingApproval,
  getPendingRequest,
  onWindowClosed,
  currentInFlight,
  ApprovalError,
  type PendingRequest,
} from './approvals';

// Track every pending promise a test creates so a leftover rejected promise always has
// a catch attached (no unhandled rejection escapes between tests).
const tracked: Promise<unknown>[] = [];
function track<T>(p: Promise<T>): Promise<T> {
  tracked.push(p.catch(() => undefined));
  return p;
}

/** Yield enough microtasks for an in-flight requestApproval to reach steady state
 * (persist + openWindow + windowId assignment all complete). */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(async () => {
  browserMock.storage.session.remove.mockReset().mockImplementation(async (key: string) => {
    session.delete(key);
  });
  session.clear();
  await rejectPendingApproval('reset').catch(() => {});
  await Promise.allSettled(tracked.splice(0));
});

/** Capture the request id the window-opener receives. */
function capture(): { id: () => string; open: (r: PendingRequest) => Promise<number> } {
  let id = '';
  return {
    id: () => id,
    open: async (r: PendingRequest) => {
      id = r.requestId;
      return 1;
    },
  };
}

describe('requestApproval / resolveApproval', () => {
  it('persists a pending request the window can read, then resolves on approve', async () => {
    let captured = '';
    const openWindow = vi.fn(async (req: PendingRequest) => {
      captured = req.requestId;
      return 42;
    });

    const pending = track(requestApproval({ kind: 'connect' }, 'https://a.example', openWindow));
    await settle();

    const rec = await getPendingRequest(captured);
    expect(rec?.origin).toBe('https://a.example');
    expect(rec?.kind).toBe('connect');
    expect(currentInFlight()?.windowId).toBe(42);

    const ok = await resolveApproval(captured, { approved: true });
    expect(ok).toBe(true);
    await expect(pending).resolves.toEqual({ approved: true });

    expect(await getPendingRequest(captured)).toBeNull();
    expect(currentInFlight()).toBeNull();
  });

  it('resolves with approved=false on reject', async () => {
    const c = capture();
    const pending = track(requestApproval({ kind: 'connect' }, 'https://a.example', c.open));
    await settle();
    await resolveApproval(c.id(), { approved: false });
    await expect(pending).resolves.toEqual({ approved: false });
  });

  it('rejects a concurrent second request (one window at a time)', async () => {
    const c = capture();
    const first = track(requestApproval({ kind: 'connect' }, 'https://a.example', c.open));

    await expect(
      requestApproval({ kind: 'connect' }, 'https://b.example', async () => 2),
    ).rejects.toMatchObject({ code: 'BUSY' });

    await resolveApproval(c.id(), { approved: true });
    await expect(first).resolves.toEqual({ approved: true });
  });

  it('does not resolve on a mismatched requestId', async () => {
    const c = capture();
    const pending = track(requestApproval({ kind: 'connect' }, 'https://a.example', c.open));
    await settle();

    expect(await resolveApproval('not-the-id', { approved: true })).toBe(false);
    expect(await resolveApproval(c.id(), { approved: true })).toBe(true);
    await expect(pending).resolves.toEqual({ approved: true });
  });
});

describe('rejectApprovalForOrigin', () => {
  it('rejects a pending request from the matching origin (revoke during pending)', async () => {
    const pending = track(requestApproval({ kind: 'connect' }, 'https://a.example', async () => 1));
    await settle();

    const rejected = await rejectApprovalForOrigin('https://a.example', 'revoked');
    expect(rejected).toBe(true);
    await expect(pending).rejects.toBeInstanceOf(ApprovalError);
  });

  it('does not reject a pending request from a different origin', async () => {
    const c = capture();
    const pending = track(requestApproval({ kind: 'connect' }, 'https://a.example', c.open));
    await settle();

    expect(await rejectApprovalForOrigin('https://other.example', 'x')).toBe(false);
    await resolveApproval(c.id(), { approved: true });
    await expect(pending).resolves.toEqual({ approved: true });
  });
});

describe('rejectPendingApproval', () => {
  it('synchronously detaches and rejects a pending connect regardless of origin', async () => {
    const pending = track(requestApproval({ kind: 'connect' }, 'https://a.example', async () => 1));
    await settle();

    const cancellation = rejectPendingApproval('locked');
    expect(currentInFlight()).toBeNull();

    await expect(cancellation).resolves.toBe(true);
    await expect(pending).rejects.toMatchObject({ code: 'LOCKED' });
    expect(session.get('pendingApproval')).toBeUndefined();
  });

  it('rejects the request even when persisted-record cleanup fails', async () => {
    const pending = track(
      requestApproval({ kind: 'signMessage', message: 'hello' }, 'https://a.example', async () => 1),
    );
    await settle();
    browserMock.storage.session.remove.mockRejectedValueOnce(new Error('storage failed'));

    const cancellation = rejectPendingApproval('locked');
    expect(currentInFlight()).toBeNull();
    await expect(cancellation).rejects.toThrow('storage failed');
    await expect(pending).rejects.toMatchObject({ code: 'LOCKED' });
  });

  it('does not open or persist a request cancelled during its initial write', async () => {
    const gate = deferred<void>();
    browserMock.storage.session.set.mockImplementationOnce(async (items) => {
      await gate.promise;
      for (const [key, value] of Object.entries(items)) session.set(key, value);
    });
    const openWindow = vi.fn(async () => 1);
    const pending = track(requestApproval({ kind: 'connect' }, 'https://a.example', openWindow));
    await vi.waitFor(() => expect(currentInFlight()).not.toBeNull());

    const cancellation = rejectPendingApproval('locked');
    expect(currentInFlight()).toBeNull();
    gate.resolve();

    await expect(cancellation).resolves.toBe(true);
    await expect(pending).rejects.toMatchObject({ code: 'LOCKED' });
    expect(openWindow).not.toHaveBeenCalled();
    expect(session.get('pendingApproval')).toBeUndefined();
  });
});

describe('onWindowClosed', () => {
  it('rejects the in-flight request when its window is dismissed', async () => {
    const pending = track(requestApproval({ kind: 'connect' }, 'https://a.example', async () => 99));
    await settle();

    await onWindowClosed(99);
    await expect(pending).rejects.toBeInstanceOf(ApprovalError);
    expect(currentInFlight()).toBeNull();
  });

  it('ignores closure of an unrelated window', async () => {
    const c = capture();
    const pending = track(requestApproval({ kind: 'connect' }, 'https://a.example', c.open));
    await settle();

    await onWindowClosed(123);
    expect(await resolveApproval(c.id(), { approved: true })).toBe(true);
    await expect(pending).resolves.toEqual({ approved: true });
  });
});
