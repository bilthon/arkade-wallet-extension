import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DelegateVtxo, SingleKey, type ContractVtxo, type Wallet } from '@arkade-os/sdk';
import { hex } from '@scure/base';
import type { DelegationConfig, DelegationSubmission } from './delegation-state';

const mocks = vi.hoisted(() => ({
  list: vi.fn(), remove: vi.fn(), read: vi.fn(), write: vi.fn(), start: vi.fn(), stop: vi.fn(),
}));
vi.mock('./delegation-state', () => ({
  listDelegationSubmissions: mocks.list, removeDelegationSubmission: mocks.remove,
  getDelegationSubmissions: mocks.read, setDelegationSubmission: mocks.write,
}));
vi.mock('./delegation-automation', () => ({ startDelegationAutomation: mocks.start }));
import { hasDelegationAutomation, initializeWalletDelegation, catchUpDelegation } from './delegation-maintenance';

const owner = SingleKey.fromHex('11'.repeat(32));
const delegate = SingleKey.fromHex('22'.repeat(32));
const ownerKey = await owner.xOnlyPublicKey();
const delegateKey = await delegate.xOnlyPublicKey();
const script = new DelegateVtxo.Script({
  pubKey: ownerKey, serverPubKey: ownerKey, delegatePubKey: delegateKey,
  csvTimelock: { type: 'blocks', value: 144n },
});
const scriptHex = hex.encode(script.pkScript);
const scope = { walletPublicKey: hex.encode(ownerKey), network: 'regtest' as const, operatorUrl: 'http://operator' };
const config: DelegationConfig = {
  enabled: true, delegate: { url: 'http://delegate', pubkey: hex.encode(await delegate.compressedPublicKey()),
    delegateAddress: script.address('tark', ownerKey).encode(), fee: '0' },
};
const contract = { type: 'delegate', script: scriptHex, params: {
  pubKey: hex.encode(ownerKey), serverPubKey: hex.encode(ownerKey),
  delegatePubKey: hex.encode(delegateKey), csvTimelock: '144',
} };
const records = new Map<string, DelegationSubmission>();
let wallet: Wallet;
let current: boolean;
let coins: ContractVtxo[];
let submit: ReturnType<typeof vi.fn>;
let indexer: ReturnType<typeof vi.fn>;
const assertCurrent = () => { if (!current) throw new Error('LOCKED'); };
function coin(vout: number): ContractVtxo {
  return {
    txid: '33'.repeat(32), vout, script: scriptHex, contractScript: scriptHex, value: 1000,
    tapTree: new Uint8Array(), forfeitTapLeafScript: [] as never, intentTapLeafScript: [] as never,
    status: { confirmed: true }, createdAt: new Date(), isUnrolled: false,
    virtualStatus: { state: 'settled', batchExpiry: Date.now() + 100_000 },
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  records.clear();
  current = true;
  coins = [coin(0)];
  mocks.list.mockImplementation(async () => [...records.values()]);
  mocks.read.mockImplementation(async () => [...records.values()]);
  mocks.write.mockImplementation(async (_, record) => { records.set(record.outpoint, record); });
  mocks.remove.mockImplementation(async (_, key) => { records.delete(key); });
  mocks.stop.mockResolvedValue(undefined);
  mocks.start.mockReturnValue({ stop: mocks.stop });
  submit = vi.fn(async (inputs) => ({ delegated: inputs, failed: [] }));
  indexer = vi.fn(async () => ({ vtxos: [] }));
  const manager = { delegate: submit };
  wallet = {
    getDelegateManager: async () => manager,
    getContractManager: async () => ({
      getContracts: async () => [contract],
      getContractsWithVtxos: async () => [{ contract, vtxos: coins }],
    }),
    getAddress: async () => config.delegate.delegateAddress,
    indexerProvider: { getVtxos: indexer }, dispose: vi.fn(async () => {}),
  } as unknown as Wallet;
});
afterEach(async () => { await wallet.dispose(); vi.useRealTimers(); });

describe('delegation maintenance', () => {
  it('catches up existing coins on startup and coalesces concurrent maintenance', async () => {
    await initializeWalletDelegation(wallet, scope, config, assertCurrent, { assertSettlementAllowed: async () => {}, assertDelegationAllowed: async () => {} });
    expect(hasDelegationAutomation(wallet)).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    await Promise.all([catchUpDelegation(wallet), catchUpDelegation(wallet)]);
    expect(submit).toHaveBeenCalledOnce();
    expect([...records.values()][0].status).toBe('delegated');
  });

  it('keeps absent records until the indexer confirms spend and authorizes replacements separately', async () => {
    await initializeWalletDelegation(wallet, scope, config, assertCurrent, { assertSettlementAllowed: async () => {}, assertDelegationAllowed: async () => {} });
    await catchUpDelegation(wallet);
    const old = coins[0];
    coins = [];
    await catchUpDelegation(wallet);
    expect(records.has(`${old.txid}:0`)).toBe(true);
    indexer.mockResolvedValue({ vtxos: [{ ...old, isSpent: true }] });
    coins = [coin(1)];
    await catchUpDelegation(wallet);
    expect(records.has(`${old.txid}:0`)).toBe(false);
    expect(records.get(`${old.txid}:1`)?.status).toBe('delegated');
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('preserves accepted status while paused and starts no automation or authorization', async () => {
    await initializeWalletDelegation(wallet, scope, { ...config, enabled: false }, assertCurrent, { assertSettlementAllowed: async () => {}, assertDelegationAllowed: async () => {} });
    await catchUpDelegation(wallet);
    expect(hasDelegationAutomation(wallet)).toBe(false);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it('disposes the SDK wallet even when automation shutdown fails', async () => {
    const dispose = wallet.dispose;
    await initializeWalletDelegation(wallet, scope, config, assertCurrent, { assertSettlementAllowed: async () => {}, assertDelegationAllowed: async () => {} });
    mocks.stop.mockRejectedValueOnce(new Error('shutdown failed'));
    await expect(wallet.dispose()).rejects.toThrow('shutdown failed');
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('cancels startup on disposal and rejects an obsolete session', async () => {
    await initializeWalletDelegation(wallet, scope, config, assertCurrent, { assertSettlementAllowed: async () => {}, assertDelegationAllowed: async () => {} });
    current = false;
    await expect(catchUpDelegation(wallet)).rejects.toThrow('LOCKED');
    await wallet.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(submit).not.toHaveBeenCalled();
    expect(mocks.stop).toHaveBeenCalledOnce();
    expect(hasDelegationAutomation(wallet)).toBe(false);
  });
});
