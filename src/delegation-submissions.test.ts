import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractVtxo, IDelegateManager } from '@arkade-os/sdk';
import { installDelegationTracking } from './delegation-submissions';
import { DelegationPolicyError } from './delegation-policy';
import { getDelegationSubmissions, setDelegationSubmission, type DelegationSubmission } from './delegation-state';

vi.mock('./delegation-state', () => ({
  getDelegationSubmissions: vi.fn(), setDelegationSubmission: vi.fn(),
}));
const scope = { walletPublicKey: '11'.repeat(32), network: 'regtest' as const, operatorUrl: 'http://operator' };
const approved = { url: 'http://delegate', pubkey: `02${'22'.repeat(32)}`, delegateAddress: 'delegate-address', fee: '0' as const };
const records = new Map<string, DelegationSubmission>();
function coin(index: number, overrides: Partial<ContractVtxo> = {}): ContractVtxo {
  return { txid: '33'.repeat(32), vout: index, value: 1000, script: 'abcd', contractScript: 'abcd',
    tapTree: new Uint8Array(),
    forfeitTapLeafScript: [] as unknown as ContractVtxo['forfeitTapLeafScript'],
    intentTapLeafScript: [] as unknown as ContractVtxo['intentTapLeafScript'],
    status: { confirmed: false }, createdAt: new Date(), isUnrolled: false,
    virtualStatus: { state: 'settled', batchExpiry: Date.now() + 100_000 }, ...overrides };
}
function setup(submit = vi.fn().mockImplementation(async (coins) => ({ delegated: coins, failed: [] }))) {
  const assertCurrent = vi.fn();
  const assertDelegationAllowed = vi.fn(async () => {});
  const manager: IDelegateManager = { delegate: submit, getDelegateInfo: vi.fn() };
  const tracking = installDelegationTracking(manager, {
    scope, delegate: approved, assertCurrent, assertDelegationAllowed, eligibleScripts: async () => new Set(['abcd']),
  });
  return { manager, submit, assertCurrent, assertDelegationAllowed, tracking };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  records.clear();
  vi.mocked(getDelegationSubmissions).mockImplementation(async () => [...records.values()]);
  vi.mocked(setDelegationSubmission).mockImplementation(async (_, record) => { records.set(record.outpoint, record); });
});
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

describe('delegation submission tracking', () => {
  it('refuses SDK signing when the pre-signing policy check rejects', async () => {
    const { manager, submit, assertDelegationAllowed } = setup();
    assertDelegationAllowed.mockRejectedValueOnce(new DelegationPolicyError('approval changed'));
    await expect(manager.delegate([coin(0)], 'wallet')).rejects.toBeInstanceOf(DelegationPolicyError);
    expect(submit).not.toHaveBeenCalled();
    expect([...records.values()][0]).toMatchObject({
      status: 'failed', error: expect.stringContaining('Delegation is paused'),
    });
  });

  it('refuses SDK signing if the session locks during the policy check', async () => {
    const { manager, submit, assertCurrent, assertDelegationAllowed } = setup();
    assertDelegationAllowed.mockImplementationOnce(async () => {
      assertCurrent.mockImplementation(() => { throw new Error('LOCKED'); });
    });
    await expect(manager.delegate([coin(0)], 'wallet')).rejects.toThrow('LOCKED');
    expect(submit).not.toHaveBeenCalled();
    expect(setDelegationSubmission).not.toHaveBeenCalled();
  });

  it('serializes receive events and catch-up, avoiding duplicate authorizations', async () => {
    const { manager, submit } = setup();
    await Promise.all([
      manager.delegate([coin(0), coin(0)], 'wallet'), manager.delegate([coin(0)], 'wallet'),
    ]);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0][0]).toHaveLength(1);
    expect([...records.values()][0]).toMatchObject({ status: 'delegated', destination: 'wallet' });
  });

  it('excludes assets, custom scripts, spent coins, exits, and mismatched script metadata', async () => {
    const { manager, submit } = setup();
    await manager.delegate([
      coin(0), coin(1, { assets: [{ assetId: 'asset', amount: 1n }] }),
      coin(2, { contractScript: 'custom', script: 'custom' }), coin(3, { isSpent: true }),
      coin(4, { spentBy: 'spending-tx' }), coin(5, { isUnrolled: true }), coin(6, { script: 'different' }), coin(7, { tapTree: undefined }),
    ], 'wallet');
    expect(submit.mock.calls[0][0].map((v: ContractVtxo) => v.vout)).toEqual([0]);
  });

  it('records partial failures with controlled messages and retries only after the cooldown', async () => {
    const secretError = { proof: 'signed-proof-never-store' };
    const submit = vi.fn().mockResolvedValueOnce({ delegated: [coin(0)], failed: [{ outpoints: [coin(1)], error: secretError }] })
      .mockImplementation(async (coins) => ({ delegated: coins, failed: [] }));
    const { manager } = setup(submit);
    await manager.delegate([coin(0), coin(1)], 'wallet');
    expect(JSON.stringify([...records.values()])).not.toContain('signed-proof');
    expect(records.get(`${coin(1).txid}:1`)).toMatchObject({ status: 'failed', attemptedAt: Date.now() });
    await manager.delegate([coin(0), coin(1)], 'wallet');
    expect(submit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    await manager.delegate([coin(0), coin(1)], 'wallet');
    expect(submit.mock.calls[1][0].map((v: ContractVtxo) => v.vout)).toEqual([1]);
  });

  it('records thrown pre-submission failures without storing raw errors', async () => {
    const { manager } = setup(vi.fn().mockRejectedValue(new Error('secret server response')));
    await expect(manager.delegate([coin(0)], 'wallet')).rejects.toThrow('Delegation was not confirmed');
    expect([...records.values()][0]).toMatchObject({ status: 'failed' });
    expect(JSON.stringify([...records.values()])).not.toContain('secret');
  });

  it.each(['thrown', 'returned'])('records %s policy failures as paused without exposing details', async (path) => {
    const policyError = new DelegationPolicyError('secret signed proof');
    const submit = path === 'thrown'
      ? vi.fn().mockRejectedValue(policyError)
      : vi.fn().mockResolvedValue({ delegated: [], failed: [{ outpoints: [coin(0)], error: policyError }] });
    const { manager } = setup(submit);
    if (path === 'thrown') {
      await expect(manager.delegate([coin(0)], 'wallet')).rejects.toBeInstanceOf(DelegationPolicyError);
    } else {
      const result = await manager.delegate([coin(0)], 'wallet');
      expect(result.failed[0].error).toBeInstanceOf(DelegationPolicyError);
      expect((result.failed[0].error as Error).message).toContain('Approve delegation again');
    }
    expect([...records.values()][0]).toMatchObject({
      status: 'failed', error: expect.stringContaining('Delegation is paused'),
    });
    expect(JSON.stringify([...records.values()])).not.toContain('secret');
    expect(JSON.stringify([...records.values()])).not.toContain('retry while unlocked');
  });

  it('passes through a session lock without recording a retryable submission failure', async () => {
    let locked = false;
    const { manager, assertCurrent } = setup(vi.fn().mockImplementation(async () => {
      locked = true;
      throw new Error('SDK error after session ended');
    }));
    assertCurrent.mockImplementation(() => { if (locked) throw new Error('LOCKED'); });
    await expect(manager.delegate([coin(0)], 'wallet')).rejects.toThrow('LOCKED');
    expect(setDelegationSubmission).not.toHaveBeenCalled();
  });

  it('records acceptance after locking but prevents queued signing', async () => {
    let locked = false;
    const { manager, submit, assertCurrent } = setup(vi.fn().mockImplementation(async (coins) => {
      locked = true;
      return { delegated: coins, failed: [] };
    }));
    assertCurrent.mockImplementation(() => { if (locked) throw new Error('LOCKED'); });
    await manager.delegate([coin(0)], 'wallet');
    await expect(manager.delegate([coin(1)], 'wallet')).rejects.toThrow('LOCKED');
    expect(submit).toHaveBeenCalledTimes(1);
    expect([...records.values()][0].status).toBe('delegated');
  });

  it('repairs failed persistence without submitting accepted coins again', async () => {
    const { manager, submit, tracking } = setup();
    vi.mocked(setDelegationSubmission).mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(manager.delegate([coin(0)], 'wallet')).rejects.toThrow('storage unavailable');
    const key = `${coin(0).txid}:0`;
    expect(await tracking.acceptedOutpoints([key], 'wallet')).toEqual(new Set([key]));
    expect(await tracking.acceptedOutpoints([key], 'other-wallet')).toEqual(new Set());
    expect(setDelegationSubmission).toHaveBeenCalledTimes(1);
    await manager.delegate([coin(0)], 'wallet');
    await manager.delegate([coin(0)], 'wallet');
    expect(submit).toHaveBeenCalledTimes(1);
    expect(setDelegationSubmission).toHaveBeenCalledTimes(2);
    expect([...records.values()][0].status).toBe('delegated');
  });

  it('serializes settlement with an in-flight delegation before reading its acceptance', async () => {
    let finishSubmission!: () => void;
    const submission = new Promise<void>((resolve) => { finishSubmission = resolve; });
    const { manager, tracking } = setup(vi.fn().mockImplementation(async (coins) => {
      await submission;
      return { delegated: coins, failed: [] };
    }));
    const delegated = manager.delegate([coin(0)], 'wallet');
    const settle = vi.fn(async () => tracking.acceptedOutpoints([`${coin(0).txid}:0`], 'wallet'));
    const settled = tracking.runExclusive(settle);
    await Promise.resolve();
    expect(settle).not.toHaveBeenCalled();
    finishSubmission();
    await delegated;
    expect(await settled).toEqual(new Set([`${coin(0).txid}:0`]));
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it('uses persisted acceptance only for the same delegate and destination', async () => {
    const { manager } = setup();
    await manager.delegate([coin(0)], 'wallet');
    const { tracking } = setup();
    const key = `${coin(0).txid}:0`;
    expect(await tracking.acceptedOutpoints([key], 'wallet')).toEqual(new Set([key]));
    expect(await tracking.acceptedOutpoints([key], 'other-wallet')).toEqual(new Set());
    records.set(key, { ...records.get(key)!, delegatePubkey: `02${'99'.repeat(32)}` });
    expect(await tracking.acceptedOutpoints([key], 'wallet')).toEqual(new Set());
  });

  it('does not rewrite durable acceptance during repeated maintenance', async () => {
    const { manager, submit } = setup();
    await manager.delegate([coin(0)], 'wallet');
    for (let pass = 0; pass < 3; pass++) {
      vi.advanceTimersByTime(60_000);
      await manager.delegate([coin(0)], 'wallet');
    }
    expect(submit).toHaveBeenCalledTimes(1);
    expect(setDelegationSubmission).toHaveBeenCalledTimes(1);
  });

  it('keeps uncertain outcomes retryable and ignores unrelated response outpoints', async () => {
    const { manager, submit } = setup(vi.fn().mockResolvedValue({ delegated: [coin(9)], failed: [] }));
    await manager.delegate([coin(0)], 'wallet');
    expect(records.size).toBe(0);
    await manager.delegate([coin(0)], 'wallet');
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('submits a changed destination but preserves earlier acceptance if it fails', async () => {
    const { manager, submit } = setup();
    await manager.delegate([coin(0)], 'wallet');
    submit.mockResolvedValueOnce({ delegated: [], failed: [{ outpoints: [coin(0)], error: 'failure' }] });
    await manager.delegate([coin(0)], 'new-wallet');
    expect(submit).toHaveBeenCalledTimes(2);
    expect([...records.values()][0]).toMatchObject({ status: 'delegated', destination: 'wallet' });
  });
});
