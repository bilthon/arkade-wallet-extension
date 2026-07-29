import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Wallet } from '@arkade-os/sdk';

const armAutoLock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('./auto-lock', () => ({ armAutoLock }));

const state = vi.hoisted(() => ({ unlocked: true }));
const wallet = vi.hoisted(() => ({}) as Wallet);
const getSessionWallet = vi.hoisted(() =>
  vi.fn(async () => {
    if (!state.unlocked) throw new Error('LOCKED');
    return wallet;
  }),
);
vi.mock('./wallet-runtime', () => ({
  isUnlocked: () => state.unlocked,
  getSessionWallet,
}));

import { getPopupWallet, getProviderWallet, requirePopupSession } from './session-access';

beforeEach(() => {
  state.unlocked = true;
  armAutoLock.mockClear();
  getSessionWallet.mockClear();
});

describe('session access policy', () => {
  it('rearms before trusted popup wallet access', async () => {
    await expect(getPopupWallet()).resolves.toBe(wallet);
    expect(armAutoLock).toHaveBeenCalledOnce();
    expect(getSessionWallet).toHaveBeenCalledOnce();
    expect(armAutoLock.mock.invocationCallOrder[0]).toBeLessThan(
      getSessionWallet.mock.invocationCallOrder[0],
    );
  });

  it('rearms popup work that acquires its wallet internally', async () => {
    await expect(requirePopupSession()).resolves.toBeUndefined();
    expect(armAutoLock).toHaveBeenCalledOnce();
    expect(getSessionWallet).not.toHaveBeenCalled();
  });

  it('never lets provider access extend the idle deadline', async () => {
    await expect(getProviderWallet()).resolves.toBe(wallet);
    await expect(getProviderWallet()).resolves.toBe(wallet);
    expect(getSessionWallet).toHaveBeenCalledTimes(2);
    expect(armAutoLock).not.toHaveBeenCalled();
  });

  it('does not arm or acquire popup work while locked', async () => {
    state.unlocked = false;
    await expect(getPopupWallet()).rejects.toThrow('LOCKED');
    await expect(requirePopupSession()).rejects.toThrow('LOCKED');
    expect(armAutoLock).not.toHaveBeenCalled();
    expect(getSessionWallet).not.toHaveBeenCalled();
  });

  it('rejects a locked provider without arming', async () => {
    state.unlocked = false;
    await expect(getProviderWallet()).rejects.toThrow('LOCKED');
    expect(armAutoLock).not.toHaveBeenCalled();
  });
});
