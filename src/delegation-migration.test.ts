import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtendedVirtualCoin, Wallet } from '@arkade-os/sdk';
import type { SessionContext } from './wallet-runtime';

const mocks = vi.hoisted(() => ({
  coins: vi.fn(), scope: vi.fn(), config: vi.fn(), records: vi.fn(), allowed: vi.fn(), catchUp: vi.fn(),
}));
vi.mock('./delegation-settings', () => ({
  ordinaryDelegationCoins: mocks.coins, delegationScope: mocks.scope,
}));
vi.mock('./wallet-scripts', () => ({ delegateCompatibleScripts: async () => new Set(['aa', 'ab']) }));
vi.mock('./delegation-state', () => ({ getDelegationConfig: mocks.config, getDelegationSubmissions: mocks.records }));
vi.mock('./delegation-provider', () => ({
  validateDelegateAddress: vi.fn(), createSessionDelegate: () => ({ assertDelegationAllowed: mocks.allowed }),
}));
vi.mock('./delegation-maintenance', () => ({ catchUpDelegation: mocks.catchUp }));
import { executeDelegationMigration, prepareDelegationMigration } from './delegation-migration';

const EXPIRY = Date.now() + 60_000;
const config = { enabled: true, delegate: { pubkey: 'delegate', url: 'url', fee: '0', delegateAddress: 'delegate-address' } };
let context: SessionContext;
let current: boolean;
let send: ReturnType<typeof vi.fn>;
let indexer: ReturnType<typeof vi.fn>;
const coin = (over: Partial<ExtendedVirtualCoin> = {}): ExtendedVirtualCoin => ({
  txid: '11'.repeat(32), vout: 0, value: 1000, script: 'bb', isSpent: false, isUnrolled: false,
  virtualStatus: { state: 'settled', batchExpiry: EXPIRY }, ...over,
}) as ExtendedVirtualCoin;

beforeEach(() => {
  vi.resetAllMocks();
  current = true;
  send = vi.fn().mockResolvedValue('new-txid');
  indexer = vi.fn().mockResolvedValue({ vtxos: [coin()] });
  context = {
    epoch: 1, network: 'regtest', assertCurrent: () => { if (!current) throw new Error('LOCKED'); },
    wallet: {
      offchainTapscript: { pkScript: new Uint8Array([0xaa]) }, dustAmount: 330n,
      getAddress: vi.fn().mockResolvedValue('our-delegated-address'),
      indexerProvider: { getVtxos: indexer }, sendBitcoin: send,
    } as unknown as Wallet,
  };
  mocks.config.mockResolvedValue(config);
  mocks.coins.mockResolvedValue([coin()]);
  mocks.records.mockResolvedValue([]);
  mocks.scope.mockResolvedValue({});
  mocks.allowed.mockResolvedValue(undefined);
  mocks.catchUp.mockResolvedValue(undefined);
});

describe('existing-fund migration', () => {
  it('reviews only ordinary live coins that need the new receiving script, without signing', async () => {
    mocks.coins.mockResolvedValue([
      coin(), coin({ script: 'aa' }), coin({ script: 'ab' }), coin({ isSpent: true }), coin({ isUnrolled: true }),
      coin({ assets: [{ assetId: 'asset', amount: 1n }] as never }),
      coin({ virtualStatus: { state: 'swept' } }),
      coin({ virtualStatus: { state: 'settled', batchExpiry: Date.now() - 1000 } }),
    ]);
    const review = await prepareDelegationMigration(context);
    expect(review).toMatchObject({ amountSats: 1000, destination: 'our-delegated-address', feeSats: 0 });
    expect(review.inputs).toHaveLength(1);
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses empty and subdust transfers instead of allowing SDK fallback selection', async () => {
    mocks.coins.mockResolvedValue([]);
    await expect(prepareDelegationMigration(context)).rejects.toThrow('No ordinary funds');
    mocks.coins.mockResolvedValue([coin({ value: 100 })]);
    indexer.mockResolvedValue({ vtxos: [coin({ value: 100 })] });
    await expect(prepareDelegationMigration(context)).rejects.toThrow('minimum');
    expect(send).not.toHaveBeenCalled();
  });

  it('requires opt-in before review', async () => {
    mocks.config.mockResolvedValue({ ...config, enabled: false });
    await expect(prepareDelegationMigration(context)).rejects.toThrow('Enable delegation');
    expect(send).not.toHaveBeenCalled();
  });

  it('binds reviews to the wallet session even if epoch repeats', async () => {
    const review = await prepareDelegationMigration(context);
    const other = { ...context, wallet: { ...context.wallet } as Wallet };
    await expect(executeDelegationMigration(other, review.reviewId)).rejects.toThrow('expired');
    expect(send).not.toHaveBeenCalled();
  });

  it('checks authoritative inputs and permits a new review after a pre-send failure', async () => {
    const review = await prepareDelegationMigration(context);
    indexer.mockResolvedValue({ vtxos: [coin({ isSpent: true })] });
    await expect(executeDelegationMigration(context, review.reviewId)).rejects.toThrow('coins changed');
    expect(send).not.toHaveBeenCalled();
    indexer.mockResolvedValue({ vtxos: [coin()] });
    const next = await prepareDelegationMigration(context);
    expect(next.reviewId).not.toBe(review.reviewId);
  });

  it.each([
    [], [coin({ value: 999 })], [coin({ script: 'cc' })], [coin({ spentBy: 'spend' })],
    [coin({ assets: [{ assetId: 'asset', amount: 1n }] as never })],
  ])('rejects missing or changed authoritative inputs %#', async (...args) => {
    const vtxos = args.length === 0 ? [] : args;
    const review = await prepareDelegationMigration(context);
    indexer.mockResolvedValue({ vtxos });
    await expect(executeDelegationMigration(context, review.reviewId)).rejects.toThrow('coins changed');
    expect(send).not.toHaveBeenCalled();
  });

  it('checks the session again after async input validation', async () => {
    const review = await prepareDelegationMigration(context);
    indexer.mockImplementation(async () => { current = false; return { vtxos: [coin()] }; });
    await expect(executeDelegationMigration(context, review.reviewId)).rejects.toThrow('LOCKED');
    expect(send).not.toHaveBeenCalled();
  });

  it('shares double clicks and treats absent acceptance as pending even when transfer succeeded', async () => {
    const review = await prepareDelegationMigration(context);
    const first = executeDelegationMigration(context, review.reviewId);
    const second = executeDelegationMigration(context, review.reviewId);
    expect(first).toBe(second);
    expect(await first).toEqual({ txid: 'new-txid', delegationPending: true });
    expect(send).toHaveBeenCalledExactlyOnceWith({ address: review.destination, amount: 1000, selectedVtxos: [coin()] });
    expect(mocks.records).toHaveBeenCalledWith({}, ['new-txid:0']);
    await executeDelegationMigration(context, review.reviewId);
    expect(send).toHaveBeenCalledOnce();
  });

  it('allows a later migration for additional funds, without reoffering spent inputs', async () => {
    const review = await prepareDelegationMigration(context);
    await executeDelegationMigration(context, review.reviewId);
    indexer.mockResolvedValue({ vtxos: [coin({ isSpent: true })] });
    await expect(prepareDelegationMigration(context)).rejects.toThrow('No ordinary funds');
    mocks.coins.mockResolvedValue([coin(), coin({ txid: '22'.repeat(32), value: 2000 })]);
    indexer.mockResolvedValue({ vtxos: [coin({ isSpent: true }), coin({ txid: '22'.repeat(32), value: 2000 })] });
    const next = await prepareDelegationMigration(context);
    expect(next.inputs).toEqual([{ txid: '22'.repeat(32), vout: 0, value: 2000 }]);
    expect(next.reviewId).not.toBe(review.reviewId);
    // Cancelling this review and opening another must not bring the spent coin back.
    expect((await prepareDelegationMigration(context)).inputs).toEqual(next.inputs);
  });

  it('does not overwrite a transfer confirmed while another review is reading coins', async () => {
    const review = await prepareDelegationMigration(context);
    let finishRead!: (coins: ExtendedVirtualCoin[]) => void;
    let startedRead!: () => void;
    const started = new Promise<void>((resolve) => { startedRead = resolve; });
    mocks.coins.mockImplementationOnce(() => {
      startedRead();
      return new Promise<ExtendedVirtualCoin[]>((resolve) => { finishRead = resolve; });
    });
    const next = prepareDelegationMigration(context);
    await started;
    const execution = executeDelegationMigration(context, review.reviewId);
    finishRead([coin()]);
    await expect(next).rejects.toThrow('Another migration operation');
    await execution;
    await executeDelegationMigration(context, review.reviewId);
    expect(send).toHaveBeenCalledOnce();
  });

  it('reports acceptance only for the new coin and approved terms', async () => {
    const review = await prepareDelegationMigration(context);
    mocks.records.mockResolvedValue([{
      status: 'delegated', destination: review.destination, delegateUrl: 'url', delegatePubkey: 'delegate',
    }]);
    expect(await executeDelegationMigration(context, review.reviewId)).toEqual({ txid: 'new-txid', delegationPending: false });
  });

  it('keeps transfer success when later catch-up fails', async () => {
    const review = await prepareDelegationMigration(context);
    mocks.catchUp.mockRejectedValue(new Error('private payload'));
    expect(await executeDelegationMigration(context, review.reviewId)).toEqual({ txid: 'new-txid', delegationPending: true });
    expect(send).toHaveBeenCalledOnce();
  });

  it('requires a fresh review after an uncertain response, without locking the session', async () => {
    const review = await prepareDelegationMigration(context);
    send.mockRejectedValueOnce(new Error('private payload'));
    await expect(executeDelegationMigration(context, review.reviewId)).rejects.toThrow('review the remaining funds');
    await expect(executeDelegationMigration(context, review.reviewId)).rejects.not.toThrow('private payload');
    expect(send).toHaveBeenCalledOnce();
    const next = await prepareDelegationMigration(context);
    expect(next.reviewId).not.toBe(review.reviewId);
    expect(send).toHaveBeenCalledOnce();
    await executeDelegationMigration(context, next.reviewId);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('excludes spent and missing inputs from a fresh review after an uncertain response', async () => {
    const review = await prepareDelegationMigration(context);
    send.mockRejectedValueOnce(new Error('lost response'));
    await expect(executeDelegationMigration(context, review.reviewId)).rejects.toThrow('not confirmed');
    indexer.mockResolvedValue({ vtxos: [coin({ isSpent: true })] });
    await expect(prepareDelegationMigration(context)).rejects.toThrow('No ordinary funds');
    indexer.mockResolvedValue({ vtxos: [] });
    await expect(prepareDelegationMigration(context)).rejects.toThrow('No ordinary funds');
    expect(send).toHaveBeenCalledOnce();
  });

  it('refuses a new review while a transfer is running, then allows review after failure', async () => {
    const review = await prepareDelegationMigration(context);
    let rejectSend!: (error: Error) => void;
    let startedSend!: () => void;
    const started = new Promise<void>((resolve) => { startedSend = resolve; });
    send.mockImplementationOnce(() => {
      startedSend();
      return new Promise<string>((_resolve, reject) => { rejectSend = reject; });
    });
    const execution = executeDelegationMigration(context, review.reviewId);
    await started;
    await expect(prepareDelegationMigration(context)).rejects.toThrow('still running');
    rejectSend(new Error('lost response'));
    await expect(execution).rejects.toThrow('not confirmed');
    expect((await prepareDelegationMigration(context)).reviewId).not.toBe(review.reviewId);
    expect(send).toHaveBeenCalledOnce();
  });
});
