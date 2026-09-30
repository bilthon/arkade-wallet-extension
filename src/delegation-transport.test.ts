import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Intent, RestDelegateProvider, type SignedIntent, type ContractVtxo, type IDelegateManager } from '@arkade-os/sdk';
import { createDelegateTransport } from './delegation-transport';
import { installDelegationTracking } from './delegation-submissions';
const save = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('./delegation-state', () => ({ getDelegationSubmissions: async () => [], setDelegationSubmission: save }));

const fetchMock = vi.fn();
const url = 'http://localhost:7012';
const info = { pubkey: `02${'11'.repeat(32)}`, fee: '0', delegateAddress: 'wallet-address' };
const intent: SignedIntent<Intent.RegisterMessage> = {
  message: { type: 'register', onchain_output_indexes: [], valid_at: 1, expire_at: 0, cosigners_public_keys: [info.pubkey] },
  proof: 'test-proof',
};

beforeEach(() => { vi.useFakeTimers(); fetchMock.mockReset(); save.mockClear(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('bounded delegate transport', () => {
  it('preserves the installed SDK request format for metadata and authorization', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(info)));
    const sdk = new RestDelegateProvider(url);
    const transport = createDelegateTransport(url);
    expect(await transport.getDelegateInfo()).toEqual(await sdk.getDelegateInfo());
    expect(fetchMock.mock.calls[0][0]).toBe(fetchMock.mock.calls[1][0]);
    await sdk.delegate(intent, ['forfeit'], { rejectReplace: true });
    const sdkRequest = fetchMock.mock.lastCall!;
    await transport.delegate(intent, ['forfeit'], { rejectReplace: true });
    const boundedRequest = fetchMock.mock.lastCall!;
    expect(boundedRequest[0]).toBe(sdkRequest[0]);
    expect(boundedRequest[1]).toMatchObject(sdkRequest[1]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('supports the legacy address field and rejects malformed metadata without response text', async () => {
    const transport = createDelegateTransport(url);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ...info, delegateAddress: undefined, delegatorAddress: info.delegateAddress })));
    expect(await transport.getDelegateInfo()).toEqual(info);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ secret: 'never-log' })));
    await expect(transport.getDelegateInfo()).rejects.toThrow('Invalid delegate metadata.');
    fetchMock.mockResolvedValueOnce(new Response('never-log', { status: 500 }));
    await expect(transport.delegate(intent, [])).rejects.toThrow('Delegate request failed.');
  });

  it('releases queued online renewal after an unconfirmed submission times out', async () => {
    fetchMock.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    const transport = createDelegateTransport(url);
    const manager: IDelegateManager = {
      getDelegateInfo: async () => info,
      delegate: async (coins) => { await transport.delegate(intent, []); return { delegated: coins, failed: [] }; },
    };
    const coin = { txid: '33'.repeat(32), vout: 0, script: 'abcd', contractScript: 'abcd',
      tapTree: new Uint8Array(), forfeitTapLeafScript: [], intentTapLeafScript: [] } as unknown as ContractVtxo;
    const tracker = installDelegationTracking(manager, {
      scope: { walletPublicKey: '11'.repeat(32), network: 'regtest', operatorUrl: 'http://operator' },
      delegate: { ...info, url, fee: '0' }, assertCurrent() {}, assertDelegationAllowed: async () => {}, eligibleScripts: async () => new Set(['abcd']),
    });
    const delegation = expect(manager.delegate([coin], 'wallet')).rejects.toThrow('not confirmed');
    const renew = vi.fn(async () => {});
    const renewal = tracker.runExclusive(renew);
    await vi.advanceTimersByTimeAsync(0);
    expect(renew).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_000);
    await delegation;
    await renewal;
    expect(renew).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ status: 'failed' }));
  });

  it.each(['metadata', 'submission'])('aborts a stalled %s request and releases its timer', async (operation) => {
    let signal: AbortSignal;
    fetchMock.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      signal = init.signal;
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    const transport = createDelegateTransport(url);
    const request = operation === 'metadata' ? transport.getDelegateInfo() : transport.delegate(intent, []);
    const rejected = expect(request).rejects.toThrow('Aborted');
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    expect(signal!.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    // A timed-out POST may already have been accepted remotely; this is not success.
  });
});
