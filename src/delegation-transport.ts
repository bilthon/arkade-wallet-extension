import { Intent, type DelegateInfo, type DelegateProvider } from '@arkade-os/sdk';

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Add a request timeout to communication with Fulmine. SDK 0.4.39's REST delegate
 * provider offers neither a timeout nor an AbortSignal option, so we implement
 * the same HTTP endpoints and payload format with a 15-second AbortController.
 *
 * Delegation submissions share a queue with online renewal. Without a timeout,
 * a stalled request could block that queue indefinitely. Keep the timeout active
 * while reading metadata too, since receiving headers does not guarantee the body
 * will arrive. Approval and policy checks belong to delegation-provider.ts.
 *
 * Aborting a submission does not undo work Fulmine may already have accepted.
 * A timeout therefore leaves acceptance unconfirmed; it does not prove rejection.
 */
export function createDelegateTransport(url: string): DelegateProvider {

  async function request<T>(path: string, read: (response: Response) => Promise<T>, init?: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${url}${path}`, { ...init, signal: controller.signal });
      if (!response.ok) throw new Error('Delegate request failed.');
      // Keep the timeout active while reading the body as well as waiting for headers.
      return await read(response);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    getDelegateInfo: () => request('/v1/delegator/info', async (response) => {
      const data: unknown = await response.json();
      if (!data || typeof data !== 'object') throw new Error('Invalid delegate metadata.');
      const info = data as Record<string, unknown>;
      // Fulmine supports the legacy field name used by older SDKs.
      const delegateAddress = info.delegateAddress || info.delegatorAddress;
      if (typeof info.pubkey !== 'string' || !info.pubkey
        || typeof info.fee !== 'string' || !info.fee
        || typeof delegateAddress !== 'string' || !delegateAddress) {
        throw new Error('Invalid delegate metadata.');
      }
      return { pubkey: info.pubkey, fee: info.fee, delegateAddress } satisfies DelegateInfo;
    }),
    delegate: (intent, forfeitTxs, options) => request('/v1/delegate', async () => {}, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intent: { message: Intent.encodeMessage(intent.message), proof: intent.proof },
        forfeit_txs: forfeitTxs,
        reject_replace: options?.rejectReplace ?? false,
      }),
    }),
  };
}
