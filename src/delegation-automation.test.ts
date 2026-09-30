import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DefaultVtxo, SingleKey, type ExtendedCoin, type ExtendedVirtualCoin, type IDelegateManager, type IWallet, type SettlementConfig, type Wallet } from '@arkade-os/sdk';
import { startDelegationAutomation } from './delegation-automation';
import { createSessionDelegate } from './delegation-provider';
import { installDelegationTracking } from './delegation-submissions';
import { hex } from '@scure/base';

vi.mock('./delegation-state', () => ({
  getDelegationSubmissions: async () => [], setDelegationSubmission: async () => {},
}));

const sdk = vi.hoisted(() => ({
  createManager: vi.fn(),
  dispose: vi.fn(async () => {}),
}));
vi.mock('@arkade-os/sdk', async (importOriginal) => ({
  ...await importOriginal<typeof import('@arkade-os/sdk')>(),
  VtxoManager: class {
    constructor(wallet: IWallet, renewal: unknown, config: SettlementConfig) {
      sdk.createManager(wallet, renewal, config);
    }
    dispose = sdk.dispose;
  },
}));

const identity = SingleKey.fromHex('11'.repeat(32));
const script = new DefaultVtxo.Script({
  pubKey: await identity.xOnlyPublicKey(),
  serverPubKey: await SingleKey.fromHex('22'.repeat(32)).xOnlyPublicKey(),
  csvTimelock: { type: 'blocks', value: 144n },
});
const foreignScript = new DefaultVtxo.Script({
  pubKey: await SingleKey.fromHex('33'.repeat(32)).xOnlyPublicKey(),
  serverPubKey: await SingleKey.fromHex('22'.repeat(32)).xOnlyPublicKey(),
  csvTimelock: { type: 'blocks', value: 144n },
});
const coin: ExtendedCoin = {
  txid: 'aa'.repeat(32), vout: 0, value: 1000,
  status: { confirmed: true }, tapTree: script.encode(),
  forfeitTapLeafScript: script.forfeit(), intentTapLeafScript: script.forfeit(),
};

function setup() {
  const assertAllowed = vi.fn(async () => {});
  const assertCurrent = vi.fn();
  const wallet = {
    identity, offchainTapscript: script, boardingTapscript: script,
    onchainProvider: { getChainTip: async () => ({ height: 10 }) },
    arkProvider: { getInfo: async () => ({ fees: { intentFee: {} }, vtxoMaxAmount: -1n }) },
    dustAmount: 330n,
    getAddress: vi.fn(async () => 'current-wallet-address'),
    getContractManager: vi.fn(async () => ({ getContracts: async () => [] })),
    getVtxos: vi.fn(async () => [coin]),
    getBoardingUtxos: vi.fn(async () => [coin]),
    settle: vi.fn(async () => 'commitment-txid'),
  } as unknown as Wallet;
  const submissions = {
    acceptedOutpoints: vi.fn(async () => new Set<string>()),
    runExclusive: async <T>(operation: () => Promise<T>) => operation(),
  };
  const automation = startDelegationAutomation(wallet, assertAllowed, assertCurrent, submissions);
  const adapter = sdk.createManager.mock.lastCall![0] as IWallet;
  const params = {
    inputs: [coin], outputs: [{ address: 'current-wallet-address', amount: 1000n }],
  };
  return { wallet, adapter, automation, assertAllowed, assertCurrent, params, submissions };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());

describe('delegation automation', () => {
  it('does not settle if the session locks during the final acceptance read', async () => {
    const { wallet, adapter, params, submissions, assertCurrent } = setup();
    submissions.acceptedOutpoints.mockImplementationOnce(async () => {
      assertCurrent.mockImplementation(() => { throw new Error('LOCKED'); });
      return new Set();
    });
    await expect(adapter.settle(params)).rejects.toThrow('LOCKED');
    expect(wallet.settle).not.toHaveBeenCalled();
  });

  it('allows an in-flight coin read to finish after locking but refuses settlement', async () => {
    const { wallet, adapter, params, assertCurrent } = setup();
    vi.mocked(wallet.getVtxos).mockImplementationOnce(async () => {
      assertCurrent.mockImplementation(() => { throw new Error('LOCKED'); });
      return [coin as ExtendedVirtualCoin];
    });
    await expect(adapter.getVtxos()).resolves.toEqual([coin]);
    await expect(adapter.settle(params)).rejects.toThrow('LOCKED');
    expect(wallet.settle).not.toHaveBeenCalled();
  });

  it('starts the SDK with onboarding enabled and a one-hour renewal margin', () => {
    const { wallet, adapter } = setup();
    expect(adapter).not.toBe(wallet);
    expect(sdk.createManager).toHaveBeenCalledWith(adapter, undefined, {
      vtxoThreshold: 60 * 60, pollIntervalMs: 60_000,
      boardingUtxoSweep: false, deprecatedSignerMigration: false,
    });
    // The SDK requires these properties even when the sweep operation is disabled.
    expect('signOnchainBoardingTx' in adapter).toBe(true);
    expect('onchainProvider' in adapter).toBe(true);
    expect('arkProvider' in adapter).toBe(true);
    expect('network' in adapter).toBe(true);
  });

  it('permits an approved zero-fee self-settlement without replacing manual settle', async () => {
    const { wallet, adapter, params, assertAllowed } = setup();
    const manualSettle = wallet.settle;
    await expect(adapter.settle(params)).resolves.toBe('commitment-txid');
    expect(assertAllowed).toHaveBeenCalledOnce();
    expect(wallet.settle).toBe(manualSettle);
    expect(wallet.settle).toHaveBeenCalledWith(params, undefined);
  });

  it('blocks settlement when the delegate or operator policy no longer allows it', async () => {
    const { wallet, adapter, params, assertAllowed } = setup();
    assertAllowed.mockRejectedValue(new Error('Delegate identity changed.'));
    await expect(adapter.settle(params)).rejects.toThrow('Delegate identity changed.');
    expect(wallet.settle).not.toHaveBeenCalled();
  });

  it('checks the session again after awaiting live policy', async () => {
    const { wallet, adapter, params, assertAllowed, assertCurrent } = setup();
    assertAllowed.mockImplementation(async () => {
      assertCurrent.mockImplementation(() => { throw new Error('LOCKED'); });
    });
    await expect(adapter.settle(params)).rejects.toThrow('LOCKED');
    expect(wallet.settle).not.toHaveBeenCalled();
  });

  it('requires explicit inputs for checking delegation acceptance', async () => {
    const { wallet, adapter, params } = setup();
    await expect(adapter.settle()).rejects.toThrow('explicit inputs');
    await expect(adapter.settle({ ...params, inputs: [] })).rejects.toThrow('explicit inputs');
    expect(wallet.settle).not.toHaveBeenCalled();
  });

  it('excludes assets, foreign scripts, and malformed scripts from automatic selection', async () => {
    const { wallet, adapter } = setup();
    const excluded = [
      { ...coin, assets: [{ assetId: 'asset', amount: '1' }] },
      { ...coin, tapTree: foreignScript.encode() },
      { ...coin, tapTree: new Uint8Array([0xff]) },
    ];
    vi.mocked(wallet.getVtxos).mockResolvedValue([coin, ...excluded] as never);
    vi.mocked(wallet.getBoardingUtxos).mockResolvedValue([coin, ...excluded]);
    expect(await adapter.getVtxos()).toEqual([coin]);
    expect(await adapter.getBoardingUtxos()).toEqual([coin]);
    expect(wallet.settle).not.toHaveBeenCalled();
  });

  it('stops pending work before disposing the SDK manager', async () => {
    const { wallet, adapter, automation, params, assertAllowed } = setup();
    assertAllowed.mockImplementation(async () => { await automation.stop(); });
    await expect(adapter.settle(params)).rejects.toThrow('automation stopped');
    expect(sdk.dispose).toHaveBeenCalledOnce();
    expect(wallet.settle).not.toHaveBeenCalled();
    await expect(adapter.getVtxos()).rejects.toThrow('automation stopped');
  });

  it('does not expose transfer or boarding sweep operations to automation', async () => {
    const { adapter } = setup();
    await expect(adapter.send({ address: 'other', amount: 1000 })).rejects.toThrow('not available');
    const sweep = (adapter as IWallet & { signOnchainBoardingTx(): Promise<never> }).signOnchainBoardingTx;
    await expect(sweep()).rejects.toThrow('not available');
  });

  it('leaves accepted coins to Fulmine until expiry, then allows online recovery', async () => {
    const { wallet, adapter, submissions } = setup();
    const accepted = {
      ...coin, virtualStatus: { state: 'settled' as const, batchExpiry: Date.now() + 60_000 },
    } as ExtendedVirtualCoin;
    const expired = {
      ...accepted, vout: 1, virtualStatus: { state: 'settled' as const, batchExpiry: Date.now() - 1 },
    };
    const swept = { ...accepted, vout: 2, virtualStatus: { state: 'swept' as const } };
    vi.mocked(wallet.getVtxos).mockResolvedValue([accepted, expired, swept]);
    submissions.acceptedOutpoints.mockResolvedValue(new Set([0, 1, 2].map((vout) => `${coin.txid}:${vout}`)));
    expect(await adapter.getVtxos()).toEqual([expired, swept]);
  });

  it('rechecks acceptance under the shared queue if delegation completes after selection', async () => {
    const { wallet, assertAllowed, assertCurrent, params } = setup();
    const info = { url: 'http://delegate', pubkey: `02${'22'.repeat(32)}`, delegateAddress: 'delegate', fee: '0' as const };
    let finish!: (result: { delegated: never[]; failed: never[] }) => void;
    const submit = vi.fn(() => new Promise<{ delegated: never[]; failed: never[] }>((resolve) => { finish = resolve; }));
    const manager: IDelegateManager = { delegate: submit, getDelegateInfo: async () => info };
    const annotated = { ...coin, script: hex.encode(script.pkScript), contractScript: hex.encode(script.pkScript) } as never;
    const submissions = installDelegationTracking(manager, {
      scope: { walletPublicKey: '11'.repeat(32), network: 'regtest', operatorUrl: 'http://operator' },
      delegate: info, assertCurrent, assertDelegationAllowed: async () => {}, eligibleScripts: async () => new Set([hex.encode(script.pkScript)]),
    });
    startDelegationAutomation(wallet, assertAllowed, assertCurrent, submissions);
    const adapter = sdk.createManager.mock.lastCall![0] as IWallet;
    const delegation = manager.delegate([annotated], 'current-wallet-address');
    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
    const settlement = adapter.settle(params);
    finish({ delegated: [annotated], failed: [] });
    await delegation;
    await expect(settlement).rejects.toThrow('selected coin was delegated');
    expect(wallet.settle).not.toHaveBeenCalled();
  });

  it.each(['poll', 'renewVtxos'])('the real SDK %s renews only eligible coins to this wallet while Fulmine is offline', async (path) => {
    vi.useFakeTimers();
    const { wallet, adapter, assertAllowed, submissions } = setup();
    const address = script.address('tark', await SingleKey.fromHex('22'.repeat(32)).xOnlyPublicKey()).encode();
    vi.mocked(wallet.getAddress).mockResolvedValue(address);
    const info = { pubkey: `02${'22'.repeat(32)}`, delegateAddress: address, fee: '0' as const };
    const remote = { getDelegateInfo: vi.fn(async () => { throw new Error('Fulmine offline'); }), delegate: vi.fn() };
    const sessionDelegate = createSessionDelegate({ enabled: true, delegate: { ...info, url: 'http://delegate' } },
      () => {}, remote, { assertOperatorAllowed: async () => {} });
    await expect(sessionDelegate.assertDelegationAllowed()).rejects.toThrow('Fulmine offline');
    assertAllowed.mockImplementation(sessionDelegate.assertSettlementAllowed);
    const coins = [0, 1, 2].map((vout) => ({
      ...coin, vout, createdAt: new Date(), script: hex.encode(script.pkScript), isUnrolled: false,
      virtualStatus: { state: 'settled' as const, batchExpiry: Date.now() + 7 * 60_000 },
    }));
    // Coin 0 was accepted earlier; coins 1 and 2 have no accepted authorization.
    submissions.acceptedOutpoints.mockResolvedValue(new Set([`${coin.txid}:0`]));
    vi.mocked(wallet.getVtxos).mockResolvedValue([
      ...coins,
      { ...coins[1], vout: 3, tapTree: foreignScript.encode() },
      { ...coins[1], vout: 4, assets: [{ assetId: 'asset', amount: 1n }] },
    ]);
    vi.mocked(wallet.getBoardingUtxos).mockResolvedValue([]);
    vi.mocked(wallet.getContractManager).mockResolvedValue({
      getContracts: async () => [], onContractEvent: () => () => {}, refreshOutpoints: async () => {},
    } as never);
    wallet.getDelegateManager = async () => undefined;
    const { VtxoManager } = await vi.importActual<typeof import('@arkade-os/sdk')>('@arkade-os/sdk');
    const manager = new VtxoManager(adapter, undefined, sdk.createManager.mock.lastCall![2]);
    try {
      if (path === 'poll') await vi.advanceTimersByTimeAsync(1000);
      else await manager.renewVtxos();
      expect(wallet.settle).toHaveBeenCalledWith({
        inputs: coins.slice(1), outputs: [{ address, amount: 2000n }],
      }, undefined);
      expect(remote.getDelegateInfo).toHaveBeenCalledOnce();
    } finally {
      await manager.dispose();
    }
  });

  it('supports the real SDK boarding poll and releases its subscription and timers', async () => {
    vi.useFakeTimers();
    const { wallet, adapter, assertAllowed } = setup();
    const unsubscribe = vi.fn();
    vi.mocked(wallet.getContractManager).mockResolvedValue({
      getContracts: async () => [], onContractEvent: () => unsubscribe,
    } as never);
    wallet.getDelegateManager = async () => undefined;
    const address = script.address('tark', await SingleKey.fromHex('22'.repeat(32)).xOnlyPublicKey()).encode();
    vi.mocked(wallet.getAddress).mockResolvedValue(address);
    vi.mocked(wallet.getVtxos).mockResolvedValue([]);
    vi.mocked(wallet.getBoardingUtxos).mockResolvedValue([
      { ...coin, status: { confirmed: true, block_height: 1 } },
    ]);
    const { VtxoManager } = await vi.importActual<typeof import('@arkade-os/sdk')>('@arkade-os/sdk');
    const manager = new VtxoManager(adapter, undefined, sdk.createManager.mock.lastCall![2]);
    try {
      await vi.advanceTimersByTimeAsync(1000);
      expect(assertAllowed).toHaveBeenCalledOnce();
      expect(wallet.settle).toHaveBeenCalledWith({
        inputs: [{ ...coin, status: { confirmed: true, block_height: 1 } }],
        outputs: [{ address, amount: 1000n }],
      }, undefined);
    } finally {
      await manager.dispose();
    }
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
