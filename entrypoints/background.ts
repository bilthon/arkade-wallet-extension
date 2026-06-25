import { onMessage } from '@/src/messaging';
import { runG0Spike } from '@/src/spike';

/**
 * Stateless request router (PLAN.md §2/§3). Holds no secret/wallet state in
 * memory between wakes — every handler rehydrates from IndexedDB on demand.
 * Phase 0 only wires `ping` (chain proof) and `runG0Spike` (the G0 harness).
 */
export default defineBackground(() => {
  onMessage('ping', ({ data }) => {
    return { pong: true as const, timestamp: Date.now(), echo: data?.echo };
  });

  onMessage('runG0Spike', ({ data }) => {
    // arkServerUrl defaults to local nigiri arkd inside the spike module.
    return runG0Spike(data?.arkServerUrl);
  });

  console.log('[arkade] background ready');
});
