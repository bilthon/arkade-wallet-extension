import { onMessage } from '@/src/messaging';
import { runG0Spike } from '@/src/spike';
import { registerAutoLock } from '@/src/keystore';

/**
 * Stateless request router (PLAN.md §2/§3). Holds no secret/wallet state in
 * memory between wakes — every handler rehydrates from IndexedDB on demand.
 * The one exception is the unlocked seed, held in `keystore.ts` module memory
 * (M1) and zeroed on lock/auto-lock. Phase 0 only wires `ping` (chain proof)
 * and `runG0Spike` (the G0 harness); unlock-flow message handlers land later.
 */
export default defineBackground(() => {
  // Track B: arm the idle auto-lock alarm handler (PLAN.md §7, Strict posture).
  registerAutoLock();

  onMessage('ping', ({ data }) => {
    return { pong: true as const, timestamp: Date.now(), echo: data?.echo };
  });

  onMessage('runG0Spike', ({ data }) => {
    // arkServerUrl defaults to local nigiri arkd inside the spike module.
    return runG0Spike(data?.arkServerUrl);
  });

  console.log('[arkade] background ready');
});
