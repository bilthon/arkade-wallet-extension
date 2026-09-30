import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Wallet } from '@arkade-os/sdk';
import type { SessionContext } from './wallet-runtime';

const mocks = vi.hoisted(() => ({
  config: vi.fn(), records: vi.fn(), transport: vi.fn(), configure: vi.fn(), fees: vi.fn(),
  catchUp: vi.fn(), validateAddress: vi.fn(),
}));
vi.mock('./delegation-state', () => ({ getDelegationConfig: mocks.config, getDelegationSubmissions: mocks.records }));
vi.mock('./delegation-transport', () => ({ createDelegateTransport: () => ({ getDelegateInfo: mocks.transport }) }));
vi.mock('./delegation-session', () => ({ configureDelegation: mocks.configure }));
vi.mock('./delegation-policy', () => ({ assertOperatorFeesZero: mocks.fees }));
vi.mock('./delegation-maintenance', () => ({ catchUpDelegation: mocks.catchUp }));
vi.mock('./delegation-provider', () => ({ validateDelegateAddress: mocks.validateAddress }));
vi.mock('./wallet', () => ({ networkConfig: () => ({ arkServerUrl: 'operator', delegateUrl: 'delegate-url' }) }));
vi.mock('./wallet-scripts', () => ({
  delegateCompatibleScripts: async () => new Set(['aa', 'ab']),
  ownedContractScript: (contract: { script: string }) =>
  contract.script === 'bad' ? null : new Uint8Array([Number.parseInt(contract.script, 16)]),
}));
import {
  approveDelegate, getDelegationSettings, previewDelegate, retryDelegation, setDelegationEnabled,
} from './delegation-settings';

const delegate = { url: 'delegate-url', pubkey: `02${'22'.repeat(32)}`, delegateAddress: 'delegate-address', fee: '0' };
let context: SessionContext;
let current: boolean;
let coins: object[];
const contracts = [
  { type: 'default', script: 'bb', params: {} },
  { type: 'delegate', script: 'aa', params: { delegatePubKey: delegate.pubkey.slice(2) } },
  { type: 'delegate', script: 'ab', params: { delegatePubKey: delegate.pubkey.slice(2) } },
  { type: 'delegate', script: 'bad', params: { delegatePubKey: delegate.pubkey.slice(2) } },
];
beforeEach(() => {
  vi.resetAllMocks();
  current = true;
  coins = [];
  context = {
    epoch: 1, network: 'regtest', assertCurrent: () => { if (!current) throw new Error('LOCKED'); },
    wallet: {
      identity: { xOnlyPublicKey: async () => new Uint8Array(32) },
      getContractManager: async () => ({ getContracts: async ({ type }: { type: string[] }) => contracts.filter((c) => type.includes(c.type)) }),
      getVtxos: async () => coins, getAddress: async () => 'our-address',
    } as unknown as Wallet,
  };
  mocks.config.mockResolvedValue({ enabled: true, delegate });
  mocks.records.mockResolvedValue([]);
  mocks.transport.mockResolvedValue(delegate);
  mocks.configure.mockResolvedValue(undefined);
  mocks.fees.mockResolvedValue(undefined);
  mocks.catchUp.mockResolvedValue(undefined);
});

describe('delegation settings', () => {
  it('reads saved approval without contacting Fulmine, allowing offline pause', async () => {
    mocks.transport.mockRejectedValue(new Error('offline'));
    const settings = await getDelegationSettings(context);
    expect(settings.config).toEqual({ enabled: true, delegate });
    await setDelegationEnabled(context, settings.sessionId, false);
    expect(mocks.configure).toHaveBeenCalledWith(context, { enabled: false, delegate });
    expect(mocks.transport).not.toHaveBeenCalled();
  });

  it('previews terms without saving and applies only the reviewed snapshot', async () => {
    const approval = await previewDelegate(context);
    expect(mocks.configure).not.toHaveBeenCalled();
    approval.delegate.pubkey = 'edited';
    await approveDelegate(context, approval.reviewId);
    expect(mocks.configure).toHaveBeenCalledWith(context, { enabled: true, delegate });
    await expect(approveDelegate(context, approval.reviewId)).rejects.toThrow('expired');
  });

  it('rejects stale approval after replacing the wallet even if epoch is reused', async () => {
    const approval = await previewDelegate(context);
    const replacement = { ...context, wallet: { ...context.wallet } as Wallet };
    await expect(approveDelegate(replacement, approval.reviewId)).rejects.toThrow('expired');
    expect(mocks.configure).not.toHaveBeenCalled();
  });

  it('fences stale pause and retry requests with a random session identifier', async () => {
    const settings = await getDelegationSettings(context);
    const replacement = { ...context, wallet: { ...context.wallet } as Wallet };
    await expect(setDelegationEnabled(replacement, settings.sessionId, false)).rejects.toThrow('Wallet changed');
    await expect(retryDelegation(replacement, settings.sessionId)).rejects.toThrow('Wallet changed');
    expect(mocks.configure).not.toHaveBeenCalled();
    expect(mocks.catchUp).not.toHaveBeenCalled();
  });

  it('keeps delegation unavailable outside regtest', async () => {
    // No wallet reads are needed just to say this network is unsupported.
    const mainnet = { ...context, network: 'bitcoin' as const, wallet: {} as Wallet };
    const settings = await getDelegationSettings(mainnet);
    expect(settings.available).toBe(false);
    expect(settings.coins).toEqual({});
    expect(mocks.config).not.toHaveBeenCalled();
    expect(mocks.records).not.toHaveBeenCalled();
    await expect(previewDelegate(mainnet)).rejects.toThrow('regtest only');
    await expect(setDelegationEnabled(mainnet, settings.sessionId, true)).rejects.toThrow('regtest only');
    expect(mocks.configure).not.toHaveBeenCalled();
  });

  it('requires zero delegate fees before offering approval', async () => {
    mocks.transport.mockResolvedValue({ ...delegate, fee: '1' });
    await expect(previewDelegate(context)).rejects.toThrow('zero-fee');
    expect(mocks.configure).not.toHaveBeenCalled();
  });

  it('checks the session after operator metadata awaits', async () => {
    mocks.fees.mockImplementation(async (_wallet, assertCurrent) => {
      current = false;
      assertCurrent();
    });
    await expect(previewDelegate(context)).rejects.toThrow('LOCKED');
    expect(mocks.configure).not.toHaveBeenCalled();
  });

  it('hides raw transport/operator/configuration errors', async () => {
    mocks.transport.mockRejectedValue(new Error('signed payload'));
    await expect(previewDelegate(context)).rejects.toThrow('Could not reach');
    mocks.transport.mockResolvedValue(delegate);
    mocks.fees.mockRejectedValue(new Error('signed payload'));
    await expect(previewDelegate(context)).rejects.toThrow('Could not confirm zero operator fees');
    mocks.fees.mockResolvedValue(undefined);
    const approval = await previewDelegate(context);
    mocks.configure.mockRejectedValue(new Error('signed payload'));
    await expect(approveDelegate(context, approval.reviewId)).rejects.toThrow('Could not enable delegation');
  });

  it('resumes through live configuration validation and delegates retry to maintenance', async () => {
    mocks.config.mockResolvedValue({ enabled: false, delegate });
    const settings = await getDelegationSettings(context);
    await setDelegationEnabled(context, settings.sessionId, true);
    expect(mocks.configure).toHaveBeenCalledWith(context, { enabled: true, delegate });
    await expect(retryDelegation(context, settings.sessionId)).rejects.toThrow('Resume delegation');
    mocks.config.mockResolvedValue({ enabled: true, delegate });
    await retryDelegation(context, settings.sessionId);
    expect(mocks.catchUp).toHaveBeenCalledWith(context.wallet);
  });

  it('preserves accepted coins while paused and shows saved failures again on resume', async () => {
    coins = [
      { txid: 'accepted', vout: 0, value: 1000, script: 'aa' },
      { txid: 'pending', vout: 0, value: 2000, script: 'ab' },
      { txid: 'failed', vout: 0, value: 3000, script: 'aa' },
    ];
    mocks.records.mockResolvedValue([
      { outpoint: 'accepted:0', status: 'delegated' },
      { outpoint: 'failed:0', status: 'failed', delegateUrl: delegate.url,
        delegatePubkey: delegate.pubkey, destination: 'our-address', attemptedAt: 1, error: 'Retry later.' },
    ]);
    mocks.config.mockResolvedValue({ enabled: false, delegate });
    expect((await getDelegationSettings(context)).summary).toEqual({
      delegated: 1, pending: 0, failed: 0, notConfigured: 2, totalSats: 6000, lastError: null,
    });

    // The same stored outcomes remain available when delegation is enabled again.
    mocks.config.mockResolvedValue({ enabled: true, delegate });
    expect((await getDelegationSettings(context)).summary).toEqual({
      delegated: 1, pending: 1, failed: 1, notConfigured: 0, totalSats: 6000, lastError: 'Retry later.',
    });
  });

  it('summarizes partial outcomes and historical compatible scripts, excluding assets/custom/spent coins', async () => {
    coins = [
      { txid: 'accepted', vout: 0, value: 1000, script: 'bb' },
      { txid: 'pending', vout: 0, value: 2000, script: 'ab' },
      { txid: 'failed', vout: 0, value: 3000, script: 'aa' },
      { txid: 'old', vout: 0, value: 4000, script: 'bb' },
      { txid: 'bad', vout: 0, value: 5000, script: 'bad' },
      { txid: 'assets', vout: 0, value: 6000, script: 'aa', assets: [{}] },
      { txid: 'spent', vout: 0, value: 7000, script: 'aa', spentBy: 'tx' },
    ];
    mocks.records.mockResolvedValue([
      { outpoint: 'accepted:0', status: 'delegated', delegateUrl: 'old-delegate' },
      { outpoint: 'failed:0', status: 'failed', delegateUrl: delegate.url,
        delegatePubkey: delegate.pubkey, destination: 'our-address', attemptedAt: 1, error: 'Controlled retry message.' },
    ]);
    expect((await getDelegationSettings(context)).summary).toEqual({
      delegated: 1, pending: 1, failed: 1, notConfigured: 1, totalSats: 10000,
      lastError: 'Controlled retry message.',
    });
  });

  it('reports accepted times by exact outpoint without marking replacement coins delegated', async () => {
    coins = [
      { txid: 'renewal', vout: 0, value: 1000, script: 'aa' },
      { txid: 'renewal', vout: 1, value: 2000, script: 'aa', isExpired: true },
    ];
    mocks.records.mockResolvedValue([
      { outpoint: 'renewal:0', status: 'delegated', submittedAt: 123, delegateUrl: 'previous-delegate' },
      { outpoint: 'old:0', status: 'delegated', submittedAt: 100 },
    ]);
    const settings = await getDelegationSettings(context);
    expect(settings.coins).toEqual({
      'renewal:0': { status: 'delegated', submittedAt: 123 },
      'renewal:1': { status: 'pending' },
    });
    expect(settings.summary.delegated).toBe(1);
    expect(settings.summary.pending).toBe(1);
  });

  it('shows only failures matching the current delegate and destination', async () => {
    coins = ['current', 'old-delegate', 'old-key', 'old-destination'].map((txid) => ({
      txid, vout: 0, value: 1000, script: 'aa',
    }));
    const failure = {
      status: 'failed', delegateUrl: delegate.url, delegatePubkey: delegate.pubkey,
      destination: 'our-address', attemptedAt: 123, error: 'The delegate could not be reached.',
    };
    mocks.records.mockResolvedValue([
      { ...failure, outpoint: 'current:0' },
      { ...failure, outpoint: 'old-delegate:0', delegateUrl: 'other' },
      { ...failure, outpoint: 'old-key:0', delegatePubkey: 'other' },
      { ...failure, outpoint: 'old-destination:0', destination: 'other' },
    ]);
    const settings = await getDelegationSettings(context);
    expect(settings.coins).toEqual({
      'current:0': { status: 'failed', attemptedAt: 123, error: failure.error },
      'old-delegate:0': { status: 'pending' },
      'old-key:0': { status: 'pending' },
      'old-destination:0': { status: 'pending' },
    });
    expect(settings.summary).toMatchObject({ failed: 1, pending: 3, lastError: failure.error });
  });

  it('explains unsupported coins without including them in ordinary-fund totals', async () => {
    coins = [
      { txid: 'legacy', vout: 0, value: 1000, script: 'bb' },
      { txid: 'asset', vout: 0, value: 2000, script: 'aa', assets: [{}] },
      { txid: 'custom', vout: 0, value: 3000, script: 'cc' },
      { txid: 'spent', vout: 0, value: 4000, script: 'aa', isSpent: true },
      { txid: 'unrolled', vout: 0, value: 5000, script: 'aa', isUnrolled: true },
    ];
    const settings = await getDelegationSettings(context);
    expect(settings.coins).toEqual({
      'legacy:0': { status: 'not-configured', reason: expect.stringContaining('migration') },
      'asset:0': { status: 'not-configured', reason: expect.stringContaining('assets') },
      'custom:0': { status: 'not-configured', reason: expect.stringContaining('contract') },
    });
    expect(settings.summary).toMatchObject({ notConfigured: 1, totalSats: 1000 });
  });

  it('distinguishes no approval from paused delegation and preserves accepted details', async () => {
    coins = [
      { txid: 'accepted', vout: 0, value: 1000, script: 'aa' },
      { txid: 'waiting', vout: 0, value: 2000, script: 'aa' },
    ];
    mocks.records.mockResolvedValue([{ outpoint: 'accepted:0', status: 'delegated', submittedAt: 123 }]);
    mocks.config.mockResolvedValue(null);
    const unconfigured = await getDelegationSettings(context);
    expect(unconfigured.coins['waiting:0']).toEqual({
      status: 'not-configured', reason: 'No delegate has been approved.',
    });
    mocks.config.mockResolvedValue({ enabled: false, delegate });
    const paused = await getDelegationSettings(context);
    expect(paused.coins['waiting:0']).toEqual({ status: 'not-configured', reason: 'Delegation is paused.' });
    expect(paused.coins['accepted:0']).toEqual({ status: 'delegated', submittedAt: 123 });
    expect(unconfigured.coins['accepted:0']).toEqual(paused.coins['accepted:0']);
  });

});
