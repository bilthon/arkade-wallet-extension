import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => [] as string[]);
const state = vi.hoisted(() => ({ didLock: true }));
const beginSessionLock = vi.hoisted(() =>
  vi.fn(() => {
    calls.push('runtime');
    return { didLock: state.didLock, disposal: Promise.resolve() };
  }),
);
vi.mock('./wallet-runtime', () => ({ beginSessionLock }));

const disposeSwaps = vi.hoisted(() =>
  vi.fn(() => {
    calls.push('lightning');
    return Promise.resolve();
  }),
);
vi.mock('./lightning', () => ({ disposeSwaps }));

const rejectPendingApproval = vi.hoisted(() =>
  vi.fn(() => {
    calls.push('approval');
    return Promise.resolve(true);
  }),
);
vi.mock('./approvals', () => ({ rejectPendingApproval }));

const clearAutoLock = vi.hoisted(() =>
  vi.fn(() => {
    calls.push('alarm');
    return Promise.resolve();
  }),
);
vi.mock('./auto-lock', () => ({ clearAutoLock }));

const emitToAllConnected = vi.hoisted(() =>
  vi.fn(() => {
    calls.push('disconnect');
    return Promise.resolve();
  }),
);
vi.mock('./provider-handlers', () => ({ emitToAllConnected }));

import { lockWallet } from './session-lock';

beforeEach(() => {
  calls.length = 0;
  state.didLock = true;
  vi.clearAllMocks();
});

describe('lockWallet', () => {
  it('fences wallet, Lightning, and approvals before its first await', async () => {
    const locking = lockWallet('manual');

    expect(calls).toEqual(['runtime', 'lightning', 'approval', 'alarm', 'disconnect']);
    expect(rejectPendingApproval).toHaveBeenCalledWith('Wallet locked by the user.');
    await expect(locking).resolves.toBeUndefined();
  });

  it('uses the same transition for idle lock', async () => {
    await lockWallet('idle');
    expect(calls).toEqual(['runtime', 'lightning', 'approval', 'alarm', 'disconnect']);
    expect(rejectPendingApproval).toHaveBeenCalledWith('Wallet locked after inactivity.');
  });

  it('stays locked and completes when cleanup operations fail', async () => {
    disposeSwaps.mockRejectedValueOnce(new Error('swap cleanup failed'));
    rejectPendingApproval.mockRejectedValueOnce(new Error('storage cleanup failed'));
    clearAutoLock.mockRejectedValueOnce(new Error('alarm cleanup failed'));
    emitToAllConnected.mockRejectedValueOnce(new Error('event failed'));

    await expect(lockWallet('manual')).resolves.toBeUndefined();
    expect(beginSessionLock).toHaveBeenCalledOnce();
    expect(calls).toEqual(['runtime']);
    expect(disposeSwaps).toHaveBeenCalledOnce();
    expect(rejectPendingApproval).toHaveBeenCalledOnce();
    expect(clearAutoLock).toHaveBeenCalledOnce();
    expect(emitToAllConnected).toHaveBeenCalledOnce();
  });

  it('avoids duplicate disconnects while still retrying harmless cleanup', async () => {
    state.didLock = false;
    await lockWallet('manual');

    expect(emitToAllConnected).not.toHaveBeenCalled();
    expect(disposeSwaps).toHaveBeenCalledOnce();
    expect(rejectPendingApproval).toHaveBeenCalledOnce();
    expect(clearAutoLock).toHaveBeenCalledOnce();
  });
});
