import { hasDelegationAutomation, catchUpDelegation } from './delegation-maintenance';
import { getSessionContext, ensureFreshVtxos, isUnlocked } from './wallet-runtime';
import { renewExpiringVtxos, recoverExpiredVtxos, getExpiredVtxoSummary } from './wallet';

/**
 * VTXO renewal scheduler (the renew-while-unlocked fallback).
 *
 * This is a *scheduling* problem under MV3, not a "build a renewer" problem — the SDK
 * does the actual renewal (`VtxoManager.renewVtxos`). A `chrome.alarms` wake is the
 * only timer that survives the SW being suspended. On each tick:
 *   • locked  → WARN only. There is no live signing session, so we just retain the last
 *               warning for the popup to show with an "unlock to renew" prompt.
 *               No signing, ever, while locked (the encrypt-at-rest invariant).
 *   • unlocked with delegation → catch up on authorizations; the SDK owns onboarding
 *                and renewal for that session. Unaccepted coins use the one-hour
 *                fallback margin; accepted coins are left to Fulmine until expiry.
 *   • otherwise unlocked → recover and renew through the existing fallback below.
 *
 * INHERENT LIMIT (documented, not a bug): under the Strict posture + the ~30s SW
 * idle-kill, after the SW dies the wallet is effectively locked, so this only runs
 * while the user keeps the wallet active/unlocked. That is expected. Delegation
 * lets Fulmine use previously accepted authorizations offline; we do NOT hold a hot key
 * to work around the SW lifecycle (it would break encrypt-at-rest for marginal gain).
 *
 * The alarm runs once a minute. The legacy fallback below retains its eight-minute
 * renewal margin; delegation-automation.ts separately configures the SDK's one-hour
 * window. Regtest VTXO lifetimes depend on the operator's selected test profile.
 */

export const ALARM_RENEWAL = 'arkade:renew';

/** Run catch-up and refresh expiry warnings once a minute while unlocked. */
export const RENEWAL_PERIOD_MINUTES = 1;

/**
 * Renewal window for the legacy fallback, used when delegation automation is off.
 * The SDK automation's separate one-hour window is set in delegation-automation.ts.
 */
export const RENEW_MARGIN_MS = 8 * 60 * 1000;

/** Where the last warning is stashed for the popup to read (no secrets — just counts). */
const WARNING_KEY = 'renewalWarning';

/**
 * How long a warning snapshot stays "fresh". After this, the popup softens/ages the
 * copy because the snapshot was written in a prior unlocked session and the SW may have
 * respawned locked since (so we can't re-read the live operator to confirm it). 10 min
 * matches the Strict auto-lock idle window — beyond it the wallet was almost certainly
 * re-locked, so the figures are best treated as "last known", not current.
 */
export const WARNING_STALE_MS = 10 * 60 * 1000;

/**
 * What the popup shows when coins need attention while locked. `expiredSats`/`count`
 * are the needs-RENEWAL figures (still-valid coins past their soft expiry);
 * `recoverableSats`/`recoverableCount` are the needs-RECOVERY figures (swept coins);
 * `nextExpiryAtMs` drives the countdown for coins still alive but approaching expiry.
 */
export interface RenewalWarning {
  /** Coins whose batch expiry elapsed but not yet swept — renew to restore. */
  expiredSats: number;
  count: number;
  /** Swept/recoverable coins — recover (operator re-issues) to restore. */
  recoverableSats: number;
  recoverableCount: number;
  /** Soonest upcoming expiry of a still-spendable coin (epoch ms), or null. */
  nextExpiryAtMs: number | null;
  /** When this snapshot was taken (epoch ms). Drives staleness aging in the UI. */
  at: number;
}

/** True when a warning is older than {@link WARNING_STALE_MS} (written a session ago). */
export function isWarningStale(w: RenewalWarning, now: number = Date.now()): boolean {
  return now - w.at > WARNING_STALE_MS;
}

export async function getRenewalWarning(): Promise<RenewalWarning | null> {
  const got = await browser.storage.local.get(WARNING_KEY);
  return (got[WARNING_KEY] as RenewalWarning | undefined) ?? null;
}

async function setRenewalWarning(w: RenewalWarning | null): Promise<void> {
  if (w === null) await browser.storage.local.remove(WARNING_KEY);
  else await browser.storage.local.set({ [WARNING_KEY]: w });
}

/**
 * One renewal tick. Safe to call from the alarm handler or on-demand (e.g. an explicit
 * "Renew now" from the popup, which always runs unlocked). Returns a small result the
 * caller can surface; never throws on the warn path.
 */
export async function runRenewalTick(): Promise<
  | { state: 'locked'; warning: RenewalWarning | null }
  | { state: 'unlocked'; renewed: number; recovered: number; txid?: string }
> {
  if (!isUnlocked()) {
    // Locked: warn only. Build a read-only view of expiry from the cached VTXO set.
    // We cannot read the live operator without a wallet, and wallet construction needs
    // the live runtime identity — so when locked we have no fresh read. Fall back
    // to leaving any prior warning in place (it was written while unlocked; the popup
    // ages the copy via `isWarningStale` so a respawn-while-locked snapshot reads as
    // "last known", not current).
    const warning = await getRenewalWarning();
    return { state: 'locked', warning };
  }

  // This is a scheduled tick, not user activity, so it goes straight to the shared
  // session wallet with no `armAutoLock()` anywhere on this path — a tick must not
  // keep extending the idle window on its own.
  const context = await getSessionContext();
  const { wallet } = context;
  // Building the wallet used to give this an implicit sync; the shared wallet no
  // longer rebuilds every tick, so we ask for one explicitly before selecting
  // renewable coins.
  await ensureFreshVtxos(context);

  // Delegate-enabled sessions already have the SDK onboarding/renewal loop. Catch up
  // authorizations here instead of racing it with the legacy automatic recovery loop.
  try {
    await catchUpDelegation(wallet);
  } catch (error) {
    if (error instanceof Error && error.message === 'LOCKED') throw error;
    // Reconciliation/storage outages must not hide expiry warnings or prevent the
    // ordinary wallet's independent recovery and renewal legs from running.
    console.warn('[arkade] delegation reconciliation failed; retrying on the next tick');
  }
  let recovered = 0;
  let renewed = 0;
  let txid: string | undefined;
  if (!hasDelegationAutomation(wallet)) {
    // Recovery must precede renewal so swept coins do not enter an ordinary batch
    // swap. Isolate the legs so one failure does not prevent the other from running.
    try {
      const rec = await recoverExpiredVtxos(context);
      recovered = rec.recovered;
      txid = rec.txid;
    } catch (err) {
      if (err instanceof Error && err.message === 'LOCKED') throw err;
      console.warn('[arkade] recovery leg failed', err);
    }

    try {
      const r = await renewExpiringVtxos(context, RENEW_MARGIN_MS);
      renewed = r.renewed;
      txid ??= r.txid;
    } catch (err) {
      if (err instanceof Error && err.message === 'LOCKED') throw err;
      console.warn('[arkade] renewal leg failed', err);
    }
  }

  // Re-read post-settle so the warning reflects the new state (ideally cleared).
  const summary = await getExpiredVtxoSummary(wallet);
  context.assertCurrent();
  const hasWork =
    summary.count > 0 ||
    summary.recoverableCount > 0 ||
    summary.nextExpiryAtMs !== null;
  await setRenewalWarning(hasWork ? { ...summary, at: Date.now() } : null);

  return { state: 'unlocked', renewed, recovered, txid };
}

/**
 * Register the recurring renewal alarm + its handler. Call once from the background
 * entrypoint (alongside `registerAutoLock`). The handler swallows errors so a single
 * failed tick (operator blip) never tears down the SW; the next tick retries.
 */
export function registerRenewal(): void {
  browser.alarms.create(ALARM_RENEWAL, { periodInMinutes: RENEWAL_PERIOD_MINUTES });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== ALARM_RENEWAL) return;
    void runRenewalTick().catch((err) => {
      console.warn('[arkade] renewal tick failed', err);
    });
  });
}
