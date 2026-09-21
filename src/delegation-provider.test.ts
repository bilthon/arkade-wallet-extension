import { describe, expect, it, vi } from 'vitest';
import { ArkAddress, SingleKey, type DelegateInfo, type DelegateProvider, type Wallet } from '@arkade-os/sdk';
import { hex } from '@scure/base';
import { createSessionDelegate, validateDelegateAddress } from './delegation-provider';
import { DelegationPolicyError } from './delegation-policy';
import type { DelegationConfig } from './delegation-state';

const operator = SingleKey.fromHex('11'.repeat(32));
const delegate = SingleKey.fromHex('22'.repeat(32));
const info = {
  pubkey: hex.encode(await delegate.compressedPublicKey()), fee: '0' as const,
  delegateAddress: new ArkAddress(await operator.xOnlyPublicKey(), await delegate.xOnlyPublicKey(), 'tark').encode(),
};
const config: DelegationConfig = { enabled: true, delegate: { url: 'http://localhost:7012', ...info } };
const fakeRemote = () => ({
  getDelegateInfo: vi.fn(async (): Promise<DelegateInfo> => ({ ...info })),
  delegate: vi.fn(async () => {}),
});

describe('session delegate provider', () => {
  it('does not publish if the session locks during signed intent validation', async () => {
    let current = true;
    const remote = fakeRemote();
    const { provider } = createSessionDelegate(config, () => {
      if (!current) throw new Error('LOCKED');
    }, remote, { validateIntent: async () => { current = false; } });
    await expect(provider.delegate({} as never, [])).rejects.toThrow('LOCKED');
    expect(remote.delegate).not.toHaveBeenCalled();
  });

  it('serves approved metadata offline and returns independent snapshots', async () => {
    const remote = fakeRemote();
    remote.getDelegateInfo.mockRejectedValue(new Error('offline'));
    const { provider } = createSessionDelegate(config, () => {}, remote);
    const cached = await provider.getDelegateInfo();
    cached.pubkey = 'changed by caller';
    expect(await provider.getDelegateInfo()).toEqual(info);
    expect(remote.getDelegateInfo).not.toHaveBeenCalled();
  });

  it('keeps paused metadata available but refuses delegation before manager work', async () => {
    const remote = fakeRemote();
    const session = createSessionDelegate({ ...config, enabled: false }, () => {}, remote);
    expect(await session.provider.getDelegateInfo()).toEqual(info);
    await expect(session.assertDelegationAllowed()).rejects.toThrow('paused');
    expect(remote.delegate).not.toHaveBeenCalled();
    expect(remote.getDelegateInfo).not.toHaveBeenCalled();
  });

  it.each([
    { pubkey: `02${'33'.repeat(32)}` }, { delegateAddress: 'another address' }, { fee: '1' },
  ])('refuses changed live metadata before submitting: %j', async (change) => {
    const remote = fakeRemote();
    remote.getDelegateInfo.mockResolvedValue({ ...info, ...change } as typeof info);
    const { provider } = createSessionDelegate(config, () => {}, remote);
    await expect(provider.delegate({} as never, [])).rejects.toThrow();
    expect(remote.delegate).not.toHaveBeenCalled();
  });

  it('checks the session again after metadata fetch', async () => {
    let current = true;
    const remote = fakeRemote();
    remote.getDelegateInfo.mockImplementation(async () => { current = false; return info; });
    const { provider } = createSessionDelegate(config, () => {
      if (!current) throw new Error('LOCKED');
    }, remote);
    await expect(provider.delegate({} as never, [])).rejects.toThrow('LOCKED');
    expect(remote.delegate).not.toHaveBeenCalled();
  });

  it('forwards an authorized submission unchanged', async () => {
    const remote = fakeRemote();
    const { provider } = createSessionDelegate(config, () => {}, remote);
    const intent = {} as never;
    await provider.delegate(intent, ['forfeit'], { rejectReplace: true });
    expect(remote.delegate).toHaveBeenCalledWith(intent, ['forfeit'], { rejectReplace: true });
  });

  it('allows online settlement during an outage but still enforces operator policy and pause', async () => {
    const remote = fakeRemote();
    remote.getDelegateInfo.mockRejectedValue(new Error('offline'));
    const checkOperator = vi.fn(async () => {});
    const pause = vi.fn();
    const session = createSessionDelegate(config, () => {}, remote, {
      assertOperatorAllowed: checkOperator, onPolicyMismatch: pause,
    });
    await session.assertSettlementAllowed();
    expect(remote.getDelegateInfo).not.toHaveBeenCalled();
    expect(checkOperator).toHaveBeenCalledOnce();
    checkOperator.mockRejectedValueOnce(new DelegationPolicyError('fees changed'));
    await expect(session.assertSettlementAllowed()).rejects.toThrow('fees changed');
    expect(pause).toHaveBeenCalledOnce();
    await expect(session.assertSettlementAllowed()).rejects.toThrow('fees changed');
    const paused = createSessionDelegate({ ...config, enabled: false }, () => {}, remote);
    await expect(paused.assertSettlementAllowed()).rejects.toThrow('paused');
  });

  it('latches a changed policy and requests pause once, even if the service changes back', async () => {
    const remote = fakeRemote();
    const pause = vi.fn();
    remote.getDelegateInfo.mockResolvedValueOnce({ ...info, fee: '1' });
    const session = createSessionDelegate(config, () => {}, remote, { onPolicyMismatch: pause });
    await expect(session.assertDelegationAllowed()).rejects.toThrow('zero-fee');
    await expect(session.assertDelegationAllowed()).rejects.toThrow('zero-fee');
    expect(pause).toHaveBeenCalledOnce();
    expect(remote.getDelegateInfo).toHaveBeenCalledOnce();
  });

  it('retries an outage without pausing the approved configuration', async () => {
    const remote = fakeRemote();
    const pause = vi.fn();
    remote.getDelegateInfo.mockRejectedValueOnce(new Error('offline'));
    const session = createSessionDelegate(config, () => {}, remote, { onPolicyMismatch: pause });
    await expect(session.assertDelegationAllowed()).rejects.toThrow('offline');
    await session.assertDelegationAllowed();
    expect(pause).not.toHaveBeenCalled();
  });

  it('pauses on operator fee changes and refuses publishing an invalid signed intent', async () => {
    const remote = fakeRemote();
    const pause = vi.fn();
    const operator = createSessionDelegate(config, () => {}, remote, {
      assertOperatorAllowed: async () => { throw new DelegationPolicyError('operator fees changed'); },
      onPolicyMismatch: pause,
    });
    await expect(operator.assertDelegationAllowed()).rejects.toThrow('operator fees changed');
    expect(pause).toHaveBeenCalledOnce();
    const session = createSessionDelegate(config, () => {}, remote, {
      validateIntent: async () => { throw new DelegationPolicyError('invalid intent'); },
      onPolicyMismatch: pause,
    });
    await expect(session.provider.delegate({} as never, [])).rejects.toThrow('invalid intent');
    expect(remote.delegate).not.toHaveBeenCalled();
    expect(pause).toHaveBeenCalledTimes(2);
  });

  it('rejects a fee address on another network or operator', async () => {
    const wallet = {
      network: { hrp: 'tark' }, arkServerPublicKey: await operator.compressedPublicKey(),
    } as Wallet;
    expect(() => validateDelegateAddress(config, wallet)).not.toThrow();
    expect(() => validateDelegateAddress(config, { ...wallet, network: { hrp: 'ark' } } as Wallet)).toThrow();
    expect(() => validateDelegateAddress(config, {
      ...wallet, arkServerPublicKey: new Uint8Array(33),
    } as Wallet)).toThrow();
  });
});
