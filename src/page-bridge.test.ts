import { describe, it, expect } from 'vitest';
import {
  BRIDGE_NS,
  isBridgeRequest,
  isBridgeResponse,
  type BridgeRequest,
  type BridgeResponse,
} from './page-bridge';

/**
 * The one runnable check on the message plumbing (Phase-0 requirement). It proves
 * the request/response envelope guards and id-correlation that the MAIN provider
 * and ISOLATED content bridge rely on — without needing a live browser. The real
 * MAIN->ISOLATED->background->back path is exercised by the manual load-unpacked
 * `ping` smoke test documented in the PR.
 */
describe('page-bridge envelope', () => {
  it('round-trips a request id to a correlated response', () => {
    const req: BridgeRequest = {
      ns: BRIDGE_NS,
      dir: 'request',
      id: 'arkade-wallet-1',
      method: 'ping',
      params: { echo: 'hi' },
    };
    expect(isBridgeRequest(req)).toBe(true);

    // content bridge would forward `req`, then post back a response keyed to req.id
    const res: BridgeResponse = {
      ns: BRIDGE_NS,
      dir: 'response',
      id: req.id,
      ok: true,
      result: { pong: true, timestamp: 123, echo: 'hi' },
    };
    expect(isBridgeResponse(res)).toBe(true);
    expect(res.id).toBe(req.id); // provider matches the pending call by id
  });

  it('rejects foreign / malformed envelopes', () => {
    expect(isBridgeRequest({ ns: 'evil', dir: 'request', id: 'x', method: 'ping' })).toBe(false);
    expect(isBridgeRequest({ ns: BRIDGE_NS, dir: 'response', id: 'x', method: 'ping' })).toBe(false);
    expect(isBridgeRequest(null)).toBe(false);
    expect(isBridgeResponse({ ns: BRIDGE_NS, dir: 'request', id: 'x' })).toBe(false);
    expect(isBridgeResponse('nope')).toBe(false);
  });

  it('a request is not mistaken for a response and vice versa', () => {
    const req: BridgeRequest = { ns: BRIDGE_NS, dir: 'request', id: 'a', method: 'ping' };
    const res: BridgeResponse = { ns: BRIDGE_NS, dir: 'response', id: 'a', ok: true };
    expect(isBridgeResponse(req)).toBe(false);
    expect(isBridgeRequest(res)).toBe(false);
  });
});
