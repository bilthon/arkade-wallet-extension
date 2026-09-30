import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BRIDGE_NS } from './page-bridge';

const { sendMessage } = vi.hoisted(() => ({ sendMessage: vi.fn() }));
vi.mock('./messaging', () => ({ sendMessage }));
vi.mock('wxt/utils/inject-script', () => ({ injectScript: vi.fn() }));

let contentMain: () => Promise<void>;
let providerMain: () => void;
const listeners: ((event: { source: unknown; data: unknown }) => void)[] = [];
const page = {
  addEventListener: vi.fn((_type: string, fn: typeof listeners[number]) => listeners.push(fn)),
  postMessage: vi.fn((data: unknown) => {
    queueMicrotask(() => listeners.forEach((fn) => fn({ source: page, data })));
  }),
  arkadeWallet: undefined as any,
};

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  listeners.length = 0;
  vi.stubGlobal('window', page);
  vi.stubGlobal('browser', { runtime: { onMessage: { addListener: vi.fn() } } });
  vi.stubGlobal('defineContentScript', (config: { main: typeof contentMain }) => { contentMain = config.main; });
  vi.stubGlobal('defineUnlistedScript', (main: typeof providerMain) => { providerMain = main; });
  await import('../entrypoints/content');
  await import('../entrypoints/provider');
  await contentMain();
  providerMain();
});

describe('linked Arkade provider bridge', () => {
  it('forwards both methods and preserves their typed results', async () => {
    const params = { arkadePsbt: 'payment', checkpoints: [{ psbt: 'checkpoint', inputIndexes: [0] }], signCheckpoints: true };
    const signed = { status: 'signed', arkadePsbt: 'signed-payment', checkpoints: ['signed-checkpoint'] };
    sendMessage.mockResolvedValueOnce(signed);
    await expect(page.arkadeWallet.approveArkadeTransaction(params)).resolves.toEqual(signed);
    expect(sendMessage).toHaveBeenLastCalledWith('providerApproveArkadeTransaction', params);

    const completion = { approvalId: 'id', checkpoints: ['operator-signed'] };
    sendMessage.mockResolvedValueOnce({ checkpoints: ['complete'] });
    await expect(page.arkadeWallet.signArkadeCheckpoints(completion)).resolves.toEqual({ checkpoints: ['complete'] });
    expect(sendMessage).toHaveBeenLastCalledWith('providerSignArkadeCheckpoints', completion);
  });

  it('preserves staged expiry and surfaces typed completion errors', async () => {
    const approval = { status: 'awaiting-checkpoints', approvalId: 'id', expiresAt: 123, arkadePsbt: 'signed-payment' };
    sendMessage.mockResolvedValueOnce(approval);
    await expect(page.arkadeWallet.approveArkadeTransaction({ arkadePsbt: 'payment', checkpoints: [] })).resolves.toEqual(approval);
    sendMessage.mockRejectedValueOnce(new Error('ARKADE_PROVIDER_ERROR:BAD_REQUEST:Approval expired.'));
    await expect(page.arkadeWallet.signArkadeCheckpoints({ approvalId: 'id', checkpoints: [] }))
      .rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'Approval expired.' });
  });

  it('does not forward unknown page methods', async () => {
    page.postMessage({ ns: BRIDGE_NS, dir: 'request', id: 'unknown', method: 'unlock' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sendMessage).not.toHaveBeenCalled();
    expect(page.postMessage).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error: 'unknown method: unlock' }), '*');
  });

  it.each([
    'getDelegationSettings', 'previewDelegate', 'approveDelegate', 'setDelegationEnabled',
    'retryDelegation', 'prepareDelegationMigration', 'executeDelegationMigration',
  ])('keeps %s private to the extension', async (method) => {
    page.postMessage({ ns: BRIDGE_NS, dir: 'request', id: 'delegation', method });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sendMessage).not.toHaveBeenCalled();
    expect(page.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      ok: false, error: `unknown method: ${method}`,
    }), '*');
  });
});
