import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArkAddress, DefaultVtxo, DelegateVtxo, SingleKey, Wallet, type WalletConfig } from '@arkade-os/sdk';
import { hex } from '@scure/base';
import type { DelegationConfig } from './delegation-state';

const readConfig = vi.hoisted(() => vi.fn());
vi.mock('./delegation-state', () => ({ getDelegationConfig: readConfig }));
import { buildWallet } from './wallet';

const buyer = SingleKey.fromHex('11'.repeat(32));
const operator = SingleKey.fromHex('22'.repeat(32));
const delegate = SingleKey.fromHex('33'.repeat(32));
const operatorKey = await operator.compressedPublicKey();
const delegateKey = await delegate.compressedPublicKey();
const options = {
  pubKey: await buyer.xOnlyPublicKey(), serverPubKey: await operator.xOnlyPublicKey(),
  csvTimelock: { type: 'blocks' as const, value: 144n },
};
const approved: DelegationConfig = {
  enabled: true, delegate: {
    url: 'http://localhost:7012', pubkey: hex.encode(delegateKey), fee: '0',
    delegateAddress: new ArkAddress(options.serverPubKey, await delegate.xOnlyPublicKey(), 'tark').encode(),
  },
};
let builds: WalletConfig[];

beforeEach(() => {
  builds = [];
  readConfig.mockReset().mockResolvedValue(null);
  vi.spyOn(Wallet, 'create').mockImplementation(async (config) => {
    builds.push(config);
    const metadata = await config.delegateProvider?.getDelegateInfo();
    const script = metadata
      ? new DelegateVtxo.Script({ ...options, delegatePubKey: hex.decode(metadata.pubkey).slice(1) })
      : new DefaultVtxo.Script(options);
    const manager = { delegate: vi.fn(), getDelegateInfo: async () => metadata };
    return {
      identity: config.identity, offchainTapscript: script,
      arkServerPublicKey: operatorKey, network: { hrp: 'tark' },
      getAddress: async () => script.address('tark', options.serverPubKey).encode(),
      getDelegateManager: async () => metadata ? manager : undefined,
      dispose: vi.fn(async () => {}),
    } as unknown as Wallet;
  });
});
afterEach(() => vi.restoreAllMocks());

describe('delegate-aware wallet construction', () => {
  it('keeps ordinary scripts and automation disabled without approval', async () => {
    const wallet = await buildWallet(buyer, 'regtest');
    expect(wallet.offchainTapscript).toBeInstanceOf(DefaultVtxo.Script);
    expect(builds[0].delegateProvider).toBeUndefined();
    expect(builds[0].settlementConfig).toBe(false);
  });

  it('builds approved and paused wallets offline with the same delegate script', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('delegate offline'));
    readConfig.mockResolvedValue(approved);
    const enabled = await buildWallet(buyer, 'regtest');
    readConfig.mockResolvedValue({ ...approved, enabled: false });
    const paused = await buildWallet(buyer, 'regtest');
    expect(enabled.offchainTapscript).toBeInstanceOf(DelegateVtxo.Script);
    expect(await paused.getAddress()).toEqual(await enabled.getAddress());
    expect(network).not.toHaveBeenCalled();
    expect(builds.every((config) => config.settlementConfig === false)).toBe(true);
  });

  it('does not load regtest approval on another network', async () => {
    readConfig.mockResolvedValue(approved);
    await buildWallet(buyer, 'signet');
    expect(readConfig).not.toHaveBeenCalled();
    expect(builds[0].delegateProvider).toBeUndefined();
  });

  it('disposes a completed SDK build if its session became stale', async () => {
    let current = true;
    const create = vi.mocked(Wallet.create);
    const build = create.getMockImplementation()!;
    let completed: Wallet;
    create.mockImplementationOnce(async (config) => {
      completed = await build(config);
      current = false;
      return completed;
    });
    await expect(buildWallet(buyer, 'regtest', () => {
      if (!current) throw new Error('LOCKED');
    })).rejects.toThrow('LOCKED');
    expect(completed!.dispose).toHaveBeenCalledOnce();
  });
});
