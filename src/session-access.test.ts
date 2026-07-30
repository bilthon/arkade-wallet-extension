import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Wallet } from '@arkade-os/sdk';
import type { SessionContext } from './wallet-runtime';

const armAutoLock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('./auto-lock', () => ({ armAutoLock }));

const state = vi.hoisted(() => ({ unlocked: true }));
const wallet = vi.hoisted(() => ({}) as Wallet);
const context = vi.hoisted(
  () =>
    ({
      wallet,
      network: 'regtest',
      epoch: 1,
      assertCurrent: vi.fn(),
    }) as SessionContext,
);
const getSessionContext = vi.hoisted(() =>
  vi.fn(async () => {
    if (!state.unlocked) throw new Error('LOCKED');
    return context;
  }),
);
vi.mock('./wallet-runtime', () => ({
  isUnlocked: () => state.unlocked,
  getSessionContext,
}));

import { getPopupContext, getProviderContext } from './session-access';

beforeEach(() => {
  state.unlocked = true;
  armAutoLock.mockClear();
  getSessionContext.mockClear();
});

describe('session access policy', () => {
  it('rearms before trusted popup wallet access', async () => {
    await expect(getPopupContext()).resolves.toBe(context);
    expect(armAutoLock).toHaveBeenCalledOnce();
    expect(getSessionContext).toHaveBeenCalledOnce();
    expect(armAutoLock.mock.invocationCallOrder[0]).toBeLessThan(
      getSessionContext.mock.invocationCallOrder[0],
    );
  });

  it('never lets provider access extend the idle deadline', async () => {
    await expect(getProviderContext()).resolves.toBe(context);
    await expect(getProviderContext()).resolves.toBe(context);
    expect(getSessionContext).toHaveBeenCalledTimes(2);
    expect(armAutoLock).not.toHaveBeenCalled();
  });

  it('does not arm or acquire popup work while locked', async () => {
    state.unlocked = false;
    await expect(getPopupContext()).rejects.toThrow('LOCKED');
    expect(armAutoLock).not.toHaveBeenCalled();
    expect(getSessionContext).not.toHaveBeenCalled();
  });

  it('rejects a locked provider without arming', async () => {
    state.unlocked = false;
    await expect(getProviderContext()).rejects.toThrow('LOCKED');
    expect(armAutoLock).not.toHaveBeenCalled();
  });
});
