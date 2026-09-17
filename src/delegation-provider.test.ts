import { describe, expect, it, vi } from 'vitest';
import { ArkAddress, SingleKey, type DelegateProvider, type Wallet } from '@arkade-os/sdk';
import { hex } from '@scure/base';
import { createSessionDelegate, guardDelegateManager, validateDelegateAddress } from './delegation-provider';
import type { DelegationConfig } from './delegation-state';

const operator = SingleKey.fromHex('11'.repeat(32));
const delegate = SingleKey.fromHex('22'.repeat(32));
const info = {
  pubkey: hex.encode(await delegate.compressedPublicKey()), fee: '0' as const,
  delegateAddress: new ArkAddress(await operator.xOnlyPublicKey(), await delegate.xOnlyPublicKey(), 'tark').encode(),
};
const config: DelegationConfig = { enabled: true, delegate: { url: 'http://localhost:7012', ...info } };
const fakeRemote = () => ({
  getDelegateInfo: vi.fn(async () => ({ ...info })),
  delegate: vi.fn(async () => {}),
});

describe('session delegate provider', () => {
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
    const submit = vi.fn();
    const manager = { delegate: submit };
    await guardDelegateManager({ getDelegateManager: async () => manager } as unknown as Wallet, session.assertDelegationAllowed);
    expect(await session.provider.getDelegateInfo()).toEqual(info);
    await expect(manager.delegate([], 'destination')).rejects.toThrow('paused');
    expect(submit).not.toHaveBeenCalled();
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
