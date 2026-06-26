import type { ProviderEvent } from './provider-api';

/**
 * Background → page provider events (PLAN.md §8). `@webext-core/messaging` is
 * request/response; provider events are a SW-initiated PUSH, so we use a small typed
 * envelope sent with `browser.tabs.sendMessage` to the content script, which relays it
 * to the MAIN-world provider over the page bridge, where `on()` handlers fire.
 *
 * We emit at minimum (team-lead brief #5): `disconnect` on revoke/lock, and
 * `networkChanged` on a network switch. `accountsChanged` is wired for completeness.
 */

export const PROVIDER_EVENT_TYPE = 'arkade-provider-event';

export interface ProviderEventMessage {
  type: typeof PROVIDER_EVENT_TYPE;
  event: ProviderEvent;
  /** Serializable payload (e.g. the new accounts, or the new network info). */
  data?: unknown;
}

export function isProviderEventMessage(m: unknown): m is ProviderEventMessage {
  return (
    typeof m === 'object' &&
    m !== null &&
    (m as ProviderEventMessage).type === PROVIDER_EVENT_TYPE &&
    typeof (m as ProviderEventMessage).event === 'string'
  );
}
