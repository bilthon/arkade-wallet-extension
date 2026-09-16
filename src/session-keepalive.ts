const HEARTBEAT_INTERVAL_MS = 20_000;
let heartbeat: ReturnType<typeof setInterval> | undefined;

/** Keep Chrome's worker idle timeout separate from the wallet's auto-lock deadline. */
export function startSessionKeepalive(): void {
  if (heartbeat !== undefined) return;
  heartbeat = setInterval(() => void keepWorkerAlive(), HEARTBEAT_INTERVAL_MS);
}

export function stopSessionKeepalive(): void {
  if (heartbeat === undefined) return;
  clearInterval(heartbeat);
  heartbeat = undefined;
}

async function keepWorkerAlive(): Promise<void> {
  if (heartbeat === undefined) return;
  try {
    // An extension API call resets Chrome's worker idle timer. This read does not
    // touch the wallet, persist key material, or re-arm the auto-lock alarm.
    await browser.runtime.getPlatformInfo();
  } catch {
    // Best effort only: a terminated worker still loses its unlocked session.
  }
}
