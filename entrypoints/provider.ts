import {
  BRIDGE_NS,
  isBridgeResponse,
  type BridgeRequest,
} from '@/src/page-bridge';

/**
 * MAIN-world provider (PLAN.md §3). An ISOLATED content script can't set
 * page-visible globals, so `window.arkadeWallet` must run in the page's MAIN world.
 *
 * WXT builds `world:'MAIN'` content scripts as web-accessible scripts for runtime
 * injection rather than static manifest content_scripts, so this is an unlisted
 * script that the ISOLATED content bridge injects at document_start via
 * `wxt/utils/inject-script`. Same mechanism the PLAN names for the Firefox port —
 * so it's already cross-browser.
 *
 * It talks to the ISOLATED content bridge over window.postMessage (per-call id);
 * the content bridge is the only half that touches `browser.runtime`.
 *
 * ponytail: Phase-0 exposes only `ping`; the full ArkadeWalletProvider interface
 * (connect/getBalance/signPsbt/…) lands in Phase 2/3.
 */
export default defineUnlistedScript(() => {
  let counter = 0;
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const res = event.data;
    if (!isBridgeResponse(res)) return;
    const entry = pending.get(res.id);
    if (!entry) return;
    pending.delete(res.id);
    if (res.ok) entry.resolve(res.result);
    else entry.reject(new Error(res.error ?? 'bridge error'));
  });

  function call<T>(method: string, params?: unknown, timeoutMs = 10_000): Promise<T> {
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

  (window as unknown as { arkadeWallet: unknown }).arkadeWallet = {
    ping: (data?: { echo?: string }) =>
      call<{ pong: true; timestamp: number; echo?: string }>('ping', data),
  };

  console.log('[arkade] window.arkadeWallet injected');
});
