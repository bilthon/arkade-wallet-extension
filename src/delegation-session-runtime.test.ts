import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArkAddress, SingleKey, type Wallet } from '@arkade-os/sdk';
import { hex } from '@scure/base';
import type { DelegationConfig } from './delegation-state';

const effects = vi.hoisted(() => ({
  write: vi.fn(), build: vi.fn(), clearAutoLock: vi.fn(async () => {}),
  emit: vi.fn(async (_event: string) => {}), disposeSwaps: vi.fn(async () => {}),
  reject: vi.fn(async () => true),
}));
vi.mock('./crypto', () => ({ mnemonicToSeed: () => new Uint8Array(64).fill(7) }));
vi.mock('./wallet', () => ({
  buildWallet: effects.build,
  networkConfig: () => ({ isMainnet: false, arkServerUrl: 'http://localhost:7071', delegateUrl: 'http://localhost:7012' }),
}));
vi.mock('./delegation-state', () => ({ setDelegationConfig: effects.write }));
vi.mock('./delegation-provider', async (original) => ({
  ...await original<typeof import('./delegation-provider')>(),
  createSessionDelegate: (_config: unknown, _current: unknown, _remote: unknown,
    checks: { assertOperatorAllowed: () => Promise<void> }) => ({
    assertDelegationAllowed: () => checks.assertOperatorAllowed(),
  }),
}));
vi.mock('./auto-lock', () => ({ clearAutoLock: effects.clearAutoLock }));
vi.mock('./lightning', () => ({ disposeSwaps: effects.disposeSwaps }));
vi.mock('./approvals', () => ({ rejectPendingApproval: effects.reject }));
vi.mock('./provider-handlers', () => ({ emitToAllConnected: effects.emit }));

import { configureDelegation } from './delegation-session';
import { lockWallet } from './session-lock';
import { beginSessionLock, getSessionContext, isUnlocked, openSession } from './wallet-runtime';

const buyer = SingleKey.fromHex('11'.repeat(32));
const operator = SingleKey.fromHex('22'.repeat(32));
const config: DelegationConfig = {
  enabled: true,
  delegate: {
    url: 'http://localhost:7012', pubkey: hex.encode(await buyer.compressedPublicKey()), fee: '0',
    delegateAddress: new ArkAddress(await operator.xOnlyPublicKey(), await buyer.xOnlyPublicKey(), 'tark').encode(),
  },
};

beforeEach(async () => {
  vi.clearAllMocks();
  effects.write.mockReset().mockResolvedValue(undefined);
  effects.build.mockImplementation(async () => ({
    identity: buyer, network: { hrp: 'tark' }, arkServerPublicKey: await operator.compressedPublicKey(),
    arkProvider: { getInfo: async () => ({ fees: { intentFee: {} } }) },
    dispose: async () => {},
  } as unknown as Wallet));
  vi.stubGlobal('browser', { storage: { local: { remove: vi.fn(async () => {}) } } });
  await openSession('test mnemonic', 'regtest');
});
afterEach(async () => { await beginSessionLock().disposal; });

describe('delegation failure cleanup with the real runtime', () => {
  it('clears the alarm, disconnects, and revokes the old context when persistence fails', async () => {
    const context = await getSessionContext();
    effects.write.mockRejectedValueOnce(new Error('storage failed'));
    await expect(configureDelegation(context, config)).rejects.toThrow('storage failed');
    expect(isUnlocked()).toBe(false);
    expect(() => context.assertCurrent()).toThrow('LOCKED');
    expect(effects.clearAutoLock).toHaveBeenCalledOnce();
    expect(effects.emit).toHaveBeenCalledExactlyOnceWith('disconnect');
    expect(effects.build).toHaveBeenCalledOnce();
    // Failure also releases the transition fence so a later unlock can succeed.
    await openSession('test mnemonic', 'regtest');
    expect(isUnlocked()).toBe(true);
  });

  it('does not emit another disconnect or unlock when a lock races with persistence', async () => {
    const context = await getSessionContext();
    effects.write.mockImplementationOnce(async () => { await lockWallet('manual'); });
    await expect(configureDelegation(context, config)).rejects.toThrow('LOCKED');
    expect(isUnlocked()).toBe(false);
    expect(effects.emit).toHaveBeenCalledExactlyOnceWith('disconnect');
    expect(effects.build).toHaveBeenCalledOnce();
  });

  it('completes the transition despite best-effort cleanup failures', async () => {
    const context = await getSessionContext();
    effects.disposeSwaps.mockRejectedValueOnce(new Error('swap cleanup failed'));
    effects.reject.mockRejectedValueOnce(new Error('approval cleanup failed'));
    await configureDelegation(context, config);
    expect(isUnlocked()).toBe(true);
    expect(effects.write).toHaveBeenCalledOnce();
    expect(effects.build).toHaveBeenCalledTimes(2);
    expect(effects.clearAutoLock).not.toHaveBeenCalled();
    expect(effects.emit).not.toHaveBeenCalled();
  });
});
