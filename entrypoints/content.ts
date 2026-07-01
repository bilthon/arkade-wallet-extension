import { injectScript } from 'wxt/utils/inject-script';
import { sendMessage } from '@/src/messaging';
import { BRIDGE_NS, isBridgeRequest, type BridgeResponse } from '@/src/page-bridge';
import { isProviderEventMessage } from '@/src/provider-events';

/**
 * ISOLATED-world bridge. Three jobs:
 *  1. Inject the MAIN-world provider (`/provider.js`) at document_start so the page
 *     gets `window.arkadeWallet` before its own scripts run.
 *  2. Forward the provider's window.postMessage requests to the background over the
 *     typed `browser.runtime` hop, and post the result back. This is the only half
 *     that can touch `browser.runtime`. It forwards a FIXED allow-list of provider
 *     methods — never an arbitrary method name — and never adds an origin field (the
 *     background derives origin from the message SENDER, not anything this page can set).
 *  3. Relay background-pushed provider EVENTS (disconnect/networkChanged/accountsChanged)
 *     into the page so the provider's `on()` handlers fire.
 */

/**
 * The provider methods this bridge will forward, mapped to their typed `sendMessage`
 * channel. A page can only invoke a method in this table; anything else is rejected
 * here before it reaches the background. (Names mirror the SDK.)
 *
 * `ping` is intentionally absent: the web-app surface is read methods + signing only.
 * `ping` stays as an internal extension smoke-test (it remains in the ProtocolMap and
 * the popup client), it is just not reachable through the page provider.
 */
const PROVIDER_METHODS: Record<string, (params: unknown) => Promise<unknown>> = {
  connect: () => sendMessage('providerConnect', undefined),
  disconnect: () => sendMessage('providerDisconnect', undefined),
  isConnected: () => sendMessage('providerIsConnected', undefined),
  getAccounts: () => sendMessage('providerGetAccounts', undefined),
  getAddress: () => sendMessage('providerGetAddress', undefined),
  getBoardingAddress: () => sendMessage('providerGetBoardingAddress', undefined),
  getPublicKey: () => sendMessage('providerGetPublicKey', undefined),
  getBalance: () => sendMessage('providerGetBalance', undefined),
  getNetwork: () => sendMessage('providerGetNetwork', undefined),
  signMessage: (params: unknown) =>
    sendMessage('providerSignMessage', params as { message: string }),
  signPsbt: (params: unknown) =>
    sendMessage('providerSignPsbt', params as { psbt: string; inputIndexes: number[] }),
};

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',
  async main() {
    await injectScript('/provider.js', { keepInDom: true });

    // ── page → background ────────────────────────────────────────────────────
    window.addEventListener('message', async (event) => {
      // Only accept messages from this same window (the page), not other frames.
      if (event.source !== window) return;
      const req = event.data;
      if (!isBridgeRequest(req)) return;

      const respond = (r: Omit<BridgeResponse, 'ns' | 'dir' | 'id'>) =>
        window.postMessage({ ns: BRIDGE_NS, dir: 'response', id: req.id, ...r }, '*');

      const handler = PROVIDER_METHODS[req.method];
      if (!handler) {
        respond({ ok: false, error: `unknown method: ${req.method}` });
        return;
      }

      try {
        const result = await handler(req.params);
        respond({ ok: true, result });
      } catch (err) {
        // The background's typed provider errors are encoded into the Error message; we
        // pass the message through verbatim so the provider can re-tag it for the web app.
        respond({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });

    // ── background → page (provider events) ──────────────────────────────────
    browser.runtime.onMessage.addListener((msg) => {
      if (!isProviderEventMessage(msg)) return;
      // Relay into the page's MAIN world via the bridge namespace; the provider listens
      // for these and dispatches to the web app's registered `on()` handlers.
      window.postMessage(
        { ns: BRIDGE_NS, dir: 'event', event: msg.event, data: msg.data },
        '*',
      );
    });

    console.log('[arkade] content bridge ready');
  },
});
