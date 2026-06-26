import {
  BRIDGE_NS,
  isBridgeResponse,
  isBridgeEvent,
  type BridgeRequest,
} from '@/src/page-bridge';
import { decodeProviderError, type ProviderEvent } from '@/src/provider-api';

/**
 * MAIN-world provider (PLAN.md §3/§8). An ISOLATED content script can't set
 * page-visible globals, so `window.arkadeWallet` must run in the page's MAIN world.
 *
 * WXT builds `world:'MAIN'` content scripts as web-accessible scripts for runtime
 * injection rather than static manifest content_scripts, so this is an unlisted
 * script the ISOLATED content bridge injects at document_start via
 * `wxt/utils/inject-script`. Same mechanism the PLAN names for the Firefox port.
 *
 * It talks to the ISOLATED content bridge over window.postMessage (per-call id); the
 * content bridge is the only half that touches `browser.runtime`. The provider is a
 * THIN pass-through — it never holds keys, never sees the seed, and forwards each call
 * by name. The background is where origin + grant gating happens; the provider just
 * surfaces typed errors back to the dapp.
 */
export default defineUnlistedScript(() => {
  let counter = 0;
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  // Dapp-registered event handlers (provider `on()` / `removeListener()`).
  const listeners: Record<ProviderEvent, Set<(...args: unknown[]) => void>> = {
    accountsChanged: new Set(),
    networkChanged: new Set(),
    disconnect: new Set(),
  };

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;

    // Responses to our calls.
    if (isBridgeResponse(data)) {
      const entry = pending.get(data.id);
      if (!entry) return;
      pending.delete(data.id);
      if (data.ok) entry.resolve(data.result);
      else entry.reject(toError(data.error));
      return;
    }

    // Background-pushed provider events (disconnect/networkChanged/accountsChanged).
    if (isBridgeEvent(data) && data.event in listeners) {
      const set = listeners[data.event as ProviderEvent];
      for (const fn of [...set]) {
        try {
          fn(data.data);
        } catch {
          // A throwing dapp handler must not break our dispatch loop.
        }
      }
    }
  });

  /** Re-tag a background error string into an Error a dapp can branch on (`.code`). */
  function toError(raw: string | undefined): Error & { code?: string } {
    const msg = raw ?? 'bridge error';
    const decoded = decodeProviderError(msg);
    if (decoded) {
      const err = new Error(decoded.message) as Error & { code?: string };
      err.code = decoded.code;
      return err;
    }
    return new Error(msg);
  }

  function call<T>(method: string, params?: unknown, timeoutMs = 60_000): Promise<T> {
    const id = `${BRIDGE_NS}-${Date.now()}-${counter++}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`${method} timed out`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      const req: BridgeRequest = { ns: BRIDGE_NS, dir: 'request', id, method, params };
      window.postMessage(req, '*');
    });
  }

  const provider = {
    // Connection (read-only grant). `connect` may open an approval window, so it gets
    // the long timeout; the rest resolve quickly.
    connect: () => call<{ accounts: string[] }>('connect').then((r) => r.accounts),
    disconnect: () => call<{ ok: true }>('disconnect').then(() => undefined),
    isConnected: () => call<{ connected: boolean }>('isConnected').then((r) => r.connected),
    getAccounts: () => call<{ accounts: string[] }>('getAccounts').then((r) => r.accounts),

    // Wallet info (read-only).
    getAddress: () => call<{ address: string }>('getAddress').then((r) => r.address),
    getBoardingAddress: () =>
      call<{ boardingAddress: string }>('getBoardingAddress').then((r) => r.boardingAddress),
    getPublicKey: () => call<{ xOnly: string; compressed: string }>('getPublicKey'),
    getBalance: () => call('getBalance'),
    getNetwork: () => call('getNetwork'),

    // Events.
    on(eventName: ProviderEvent, handler: (...args: unknown[]) => void) {
      if (eventName in listeners) listeners[eventName].add(handler);
    },
    removeListener(eventName: ProviderEvent, handler: (...args: unknown[]) => void) {
      if (eventName in listeners) listeners[eventName].delete(handler);
    },

    // Phase-0 smoke-test, kept for the chain check.
    ping: (data?: { echo?: string }) =>
      call<{ pong: true; timestamp: number; echo?: string }>('ping', data),
  };

  (window as unknown as { arkadeWallet: typeof provider }).arkadeWallet = provider;

  console.log('[arkade] window.arkadeWallet injected');
});
