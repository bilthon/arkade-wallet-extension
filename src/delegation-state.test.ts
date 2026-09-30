import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getDelegationConfig,
  setDelegationConfig,
  getDelegationSubmissions,
  listDelegationSubmissions,
  setDelegationSubmission,
  removeDelegationSubmission,
  type DelegationScope,
  type DelegationConfig,
  type DelegationSubmission,
} from './delegation-state';

const stored = new Map<string, unknown>();
const scope: DelegationScope = {
  walletPublicKey: '11'.repeat(32), network: 'regtest', operatorUrl: 'http://localhost:7071',
};
const config: DelegationConfig = {
  enabled: true,
  delegate: {
    url: 'http://localhost:7012', pubkey: `02${'22'.repeat(32)}`,
    delegateAddress: 'tark1delegate', fee: '0',
  },
};
const submission: DelegationSubmission = {
  outpoint: `${'33'.repeat(32)}:0`,
  delegateUrl: config.delegate.url,
  delegatePubkey: config.delegate.pubkey,
  destination: 'tark1wallet',
  status: 'delegated',
  submittedAt: 1_700_000_000_000,
};

beforeEach(() => {
  stored.clear();
  vi.stubGlobal('browser', { storage: { local: {
    get: async (keys: string | string[] | null) => Object.fromEntries(
      (keys === null ? [...stored.keys()] : typeof keys === 'string' ? [keys] : keys)
        .map((key) => [key, structuredClone(stored.get(key))]),
    ),
    set: async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) stored.set(key, structuredClone(value));
    },
    remove: async (key: string) => { stored.delete(key); },
  } } });
});

afterEach(() => vi.unstubAllGlobals());

describe('delegation state', () => {
  it('starts without approval or submission history', async () => {
    expect(await getDelegationConfig(scope)).toBeNull();
    expect(await getDelegationSubmissions(scope, [submission.outpoint])).toEqual([]);
  });

  it('persists approval and submissions across module reloads', async () => {
    await setDelegationConfig(scope, config);
    await setDelegationSubmission(scope, submission);
    vi.resetModules();
    const reloaded = await import('./delegation-state');
    expect(await reloaded.getDelegationConfig(scope)).toEqual(config);
    expect(await reloaded.getDelegationSubmissions(scope, [submission.outpoint])).toEqual([submission]);
  });

  it.each([
    { walletPublicKey: '44'.repeat(32) },
    { network: 'signet' as const },
    { operatorUrl: 'http://localhost:7070' },
  ])('isolates approvals and records by scope: %j', async (different) => {
    await setDelegationConfig(scope, config);
    await setDelegationSubmission(scope, submission);
    const other = { ...scope, ...different };
    expect(await getDelegationConfig(other)).toBeNull();
    expect(await getDelegationSubmissions(other, [submission.outpoint])).toEqual([]);
  });

  it('pauses and changes approval without rewriting accepted authorizations', async () => {
    await setDelegationConfig(scope, config);
    await setDelegationSubmission(scope, submission);
    await setDelegationConfig(scope, { ...config, enabled: false });
    expect((await getDelegationConfig(scope))?.enabled).toBe(false);
    await setDelegationConfig(scope, {
      ...config, delegate: { ...config.delegate, pubkey: `02${'55'.repeat(32)}` },
    });
    expect(await getDelegationSubmissions(scope, [submission.outpoint])).toEqual([submission]);
  });

  it('retains concurrent coin outcomes and removes only the requested record', async () => {
    const failed: DelegationSubmission = {
      ...submission, outpoint: `${'66'.repeat(32)}:1`, status: 'failed',
      attemptedAt: 1_700_000_000_001, error: 'Delegate unavailable',
    };
    await Promise.all([
      setDelegationSubmission(scope, submission), setDelegationSubmission(scope, failed),
    ]);
    expect(await getDelegationSubmissions(scope, [submission.outpoint, failed.outpoint]))
      .toEqual([submission, {
        outpoint: failed.outpoint, delegateUrl: failed.delegateUrl,
        delegatePubkey: failed.delegatePubkey, destination: failed.destination,
        status: 'failed', attemptedAt: failed.attemptedAt, error: failed.error,
      }]);
    await removeDelegationSubmission(scope, failed.outpoint);
    expect(await getDelegationSubmissions(scope, [submission.outpoint, failed.outpoint])).toEqual([submission]);
  });

  it('does not persist extra SDK payload fields', async () => {
    await setDelegationConfig(scope, { ...config, proof: 'must not persist' } as DelegationConfig);
    await setDelegationSubmission(scope, { ...submission, psbt: 'must not persist' } as DelegationSubmission);
    expect(JSON.stringify([...stored.values()])).not.toContain('must not persist');
  });

  it('rejects nonzero fees even when supplied outside the typed interface', async () => {
    const paid = { ...config, delegate: { ...config.delegate, fee: '100' } };
    await expect(setDelegationConfig(scope, paid as DelegationConfig)).rejects.toThrow('zero-fee');
    expect(await getDelegationConfig(scope)).toBeNull();
  });

  it.each([null, {}, { enabled: 'true', delegate: config.delegate },
    { ...config, delegate: { ...config.delegate, fee: '100' } },
    { ...config, delegate: { ...config.delegate, pubkey: 'invalid' } },
  ])('fails closed on malformed stored approval: %j', async (value) => {
    await setDelegationConfig(scope, config);
    const key = [...stored.keys()][0];
    stored.set(key, value);
    expect(await getDelegationConfig(scope)).toBeNull();
  });

  it.each([
    { status: 'unknown' }, { submittedAt: -1 }, { submittedAt: 'yesterday' },
    { outpoint: `${'77'.repeat(32)}:0` },
    { status: 'failed', attemptedAt: 10, error: { proof: 'raw response' } },
  ])('omits malformed or mismatched stored records: %j', async (changes) => {
    await setDelegationSubmission(scope, submission);
    stored.set([...stored.keys()][0], { ...submission, ...changes });
    expect(await getDelegationSubmissions(scope, [submission.outpoint])).toEqual([]);
    expect(await listDelegationSubmissions(scope)).toEqual([]);
  });

  it('enumerates obsolete records within one scope for cleanup', async () => {
    const other = { ...scope, walletPublicKey: '88'.repeat(32) };
    await setDelegationConfig(scope, config);
    await setDelegationSubmission(scope, submission);
    await setDelegationSubmission(other, submission);
    stored.set('unrelated', { message: 'not a submission' });
    expect(await listDelegationSubmissions(scope)).toEqual([submission]);
    await removeDelegationSubmission(scope, submission.outpoint);
    expect(await listDelegationSubmissions(scope)).toEqual([]);
    expect(await listDelegationSubmissions(other)).toEqual([submission]);
    expect(await getDelegationConfig(scope)).toEqual(config);
  });

  it('rejects runtime error objects rather than persisting SDK payloads', async () => {
    const invalid = {
      ...submission, status: 'failed', attemptedAt: 10, error: { proof: 'raw response' },
    };
    await expect(setDelegationSubmission(scope, invalid as unknown as DelegationSubmission))
      .rejects.toThrow('Invalid delegation submission');
    expect(await listDelegationSubmissions(scope)).toEqual([]);
  });
});
