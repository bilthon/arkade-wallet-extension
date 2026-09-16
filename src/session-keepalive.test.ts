import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NetworkName } from '@arkade-os/sdk';

vi.mock('./crypto', () => ({ mnemonicToSeed: () => new Uint8Array(64).fill(7) }));
vi.mock('./wallet', () => ({
  buildWallet: vi.fn(),
  networkConfig: (network: NetworkName) => ({ isMainnet: network === 'bitcoin' }),
}));

import {
  beginRuntimeNetworkSwitch,
  beginSessionLock,
  getRuntimeVersion,
  isUnlocked,
  openSession,
  prepareRuntimeNetworkSwitch,
} from './wallet-runtime';
import { armAutoLock, registerAutoLock } from './auto-lock';

const getPlatformInfo = vi.fn(async () => ({ os: 'linux', arch: 'x86-64' }));
const createAlarm = vi.fn();
let onAlarm: (alarm: { name: string }) => void;

beforeEach(async () => {
  await beginSessionLock().disposal;
  vi.useFakeTimers();
  getPlatformInfo.mockReset().mockResolvedValue({ os: 'linux', arch: 'x86-64' });
  createAlarm.mockReset();
  vi.stubGlobal('browser', {
    runtime: { getPlatformInfo },
    alarms: {
      create: createAlarm,
      onAlarm: { addListener: (listener: typeof onAlarm) => { onAlarm = listener; } },
    },
  });
});

afterEach(async () => {
  await beginSessionLock().disposal;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('unlocked session keepalive', () => {
  it('runs every 20 seconds only after unlock, without re-arming auto-lock', async () => {
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getPlatformInfo).not.toHaveBeenCalled();
    await openSession('test mnemonic', 'regtest');
    await vi.advanceTimersByTimeAsync(19_999);
    expect(getPlatformInfo).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(40_001);
    expect(getPlatformInfo).toHaveBeenCalledTimes(3);
    expect(createAlarm).not.toHaveBeenCalled();
    beginSessionLock();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getPlatformInfo).toHaveBeenCalledTimes(3);
  });

  it('does not duplicate the timer when replacing an unlocked session', async () => {
    await openSession('test mnemonic', 'regtest');
    await openSession('test mnemonic', 'regtest');
    await vi.advanceTimersByTimeAsync(40_000);
    expect(getPlatformInfo).toHaveBeenCalledTimes(2);
    beginSessionLock();
    beginSessionLock();
    await openSession('test mnemonic', 'regtest');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(getPlatformInfo).toHaveBeenCalledTimes(3);
  });

  it('stops during a network transition and restarts after installation', async () => {
    await openSession('test mnemonic', 'regtest');
    const prepared = prepareRuntimeNetworkSwitch('test mnemonic', 'mutinynet', getRuntimeVersion());
    const transition = beginRuntimeNetworkSwitch(prepared);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(getPlatformInfo).not.toHaveBeenCalled();
    expect(transition.install()).toBe(true);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(getPlatformInfo).toHaveBeenCalledOnce();
  });

  it('does not restart after a cancelled network transition', async () => {
    await openSession('test mnemonic', 'regtest');
    const prepared = prepareRuntimeNetworkSwitch('test mnemonic', 'mutinynet', getRuntimeVersion());
    const transition = beginRuntimeNetworkSwitch(prepared);
    beginSessionLock();
    expect(transition.install()).toBe(false);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(getPlatformInfo).not.toHaveBeenCalled();
    expect(isUnlocked()).toBe(false);
  });

  it('does not start when switching networks while locked', async () => {
    const prepared = prepareRuntimeNetworkSwitch('test mnemonic', 'mutinynet', getRuntimeVersion());
    const transition = beginRuntimeNetworkSwitch(prepared);
    expect(transition.install()).toBe(false);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(getPlatformInfo).not.toHaveBeenCalled();
  });

  it('handles API failures without unhandled rejections or restarting after lock', async () => {
    getPlatformInfo.mockRejectedValueOnce(new Error('unavailable'));
    await openSession('test mnemonic', 'regtest');
    await vi.advanceTimersByTimeAsync(40_000);
    expect(getPlatformInfo).toHaveBeenCalledTimes(2);
    getPlatformInfo.mockImplementationOnce(() => { throw new Error('context invalidated'); });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(getPlatformInfo).toHaveBeenCalledTimes(3);
    beginSessionLock();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(getPlatformInfo).toHaveBeenCalledTimes(3);
  });

  it('leaves the existing 10-minute auto-lock deadline in control', async () => {
    registerAutoLock(() => { beginSessionLock(); });
    createAlarm.mockImplementation((name: string, { delayInMinutes }: { delayInMinutes: number }) => {
      setTimeout(() => onAlarm({ name }), delayInMinutes * 60_000);
    });
    await openSession('test mnemonic', 'regtest');
    await armAutoLock();
    await vi.advanceTimersByTimeAsync(599_999);
    expect(isUnlocked()).toBe(true);
    expect(getPlatformInfo).toHaveBeenCalledTimes(29);
    await vi.advanceTimersByTimeAsync(1);
    expect(isUnlocked()).toBe(false);
    const callsAtLock = getPlatformInfo.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getPlatformInfo).toHaveBeenCalledTimes(callsAtLock);
    expect(createAlarm).toHaveBeenCalledExactlyOnceWith('arkade:auto-lock', { delayInMinutes: 10 });
  });
});
