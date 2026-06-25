/**
 * window.postMessage envelope shared by the MAIN-world provider and the ISOLATED
 * content script (PLAN.md §3). An ISOLATED content script can't set page globals,
 * so the provider runs in MAIN and these two halves talk over postMessage with a
 * namespaced, per-call id. The content script is the only thing that touches
 * `browser.runtime`.
 */
export const BRIDGE_NS = 'arkade-wallet';

/** MAIN provider -> ISOLATED content: "please run this method". */
export interface BridgeRequest {
  ns: typeof BRIDGE_NS;
  dir: 'request';
  id: string;
  method: string;
  params?: unknown;
}

/** ISOLATED content -> MAIN provider: the result (or error) for `id`. */
export interface BridgeResponse {
  ns: typeof BRIDGE_NS;
  dir: 'response';
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export function isBridgeRequest(d: unknown): d is BridgeRequest {
  return (
    typeof d === 'object' &&
    d !== null &&
    (d as BridgeRequest).ns === BRIDGE_NS &&
    (d as BridgeRequest).dir === 'request' &&
    typeof (d as BridgeRequest).id === 'string' &&
    typeof (d as BridgeRequest).method === 'string'
  );
}

export function isBridgeResponse(d: unknown): d is BridgeResponse {
  return (
    typeof d === 'object' &&
    d !== null &&
    (d as BridgeResponse).ns === BRIDGE_NS &&
    (d as BridgeResponse).dir === 'response' &&
    typeof (d as BridgeResponse).id === 'string'
  );
}
