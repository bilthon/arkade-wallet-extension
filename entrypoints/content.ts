import { injectScript } from 'wxt/utils/inject-script';
import { sendMessage } from '@/src/messaging';
import { BRIDGE_NS, isBridgeRequest, type BridgeResponse } from '@/src/page-bridge';

/**
 * ISOLATED-world bridge (PLAN.md §3). Two jobs:
 *  1. Inject the MAIN-world provider (`/provider.js`) at document_start so the page
 *     gets `window.arkadeWallet` before its own scripts run.
 *  2. Receive the provider's window.postMessage requests, forward them to the
 *     background over the typed `browser.runtime` hop, and post the result back.
 *     This is the only half that can touch `browser.runtime`.
 *
 * ponytail: Phase-0 forwards just `ping`. Real origin validation and the full
 * provider method set (connect/getBalance/signPsbt/…) are added in Phase 2/3.
 */
export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',
  async main() {
    await injectScript('/provider.js', { keepInDom: true });

    window.addEventListener('message', async (event) => {
      // Only accept messages from this same window (the page), not other frames.
      if (event.source !== window) return;
      const req = event.data;
      if (!isBridgeRequest(req)) return;

      const respond = (r: Omit<BridgeResponse, 'ns' | 'dir' | 'id'>) =>
        window.postMessage({ ns: BRIDGE_NS, dir: 'response', id: req.id, ...r }, '*');

      try {
        if (req.method === 'ping') {
          const result = await sendMessage('ping', req.params as { echo?: string } | undefined);
          respond({ ok: true, result });
        } else {
          respond({ ok: false, error: `unknown method: ${req.method}` });
        }
      } catch (err) {
        respond({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });

    console.log('[arkade] content bridge ready');
  },
});
