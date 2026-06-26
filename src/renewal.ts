import { isUnlocked, getUnlockedSeed, armAutoLock } from './keystore';
import { buildWallet, renewExpiringVtxos, getExpiredVtxoSummary } from './wallet';

/**
 * Track F — VTXO renewal scheduler (the renew-while-unlocked fallback, BUILD_PLAN
 * Track F; PLAN.md §7.1).
 *
 * This is a *scheduling* problem under MV3, not a "build a renewer" problem — the SDK
 * does the actual renewal (`VtxoManager.renewVtxos`). A `chrome.alarms` wake is the
 * only timer that survives the SW being suspended. On each tick:
 *   • locked  → WARN only. We cannot sign without the seed, so we just record how many
 *               coins are expiring (the popup reads it and prompts "unlock to renew").
 *               No signing, ever, while locked (the encrypt-at-rest invariant).
 *   • unlocked → renew every VTXO within RENEW_MARGIN_MS of its batch expiry via the
 *                deliberate `renewExpiringVtxos` path (settlementConfig stays false;
 *                we renew EXPLICITLY, not by re-enabling the silent poll).
 *
 * INHERENT LIMIT (documented, not a bug): under the Strict posture + the ~30s SW
 * idle-kill, after the SW dies the wallet is effectively locked, so this only runs
 * while the user keeps the wallet active/unlocked. That is expected. Delegation
 * (Track F part 2, Mutinynet) is the real unattended answer; we do NOT hold a hot key
 * to work around the SW lifecycle (it would break encrypt-at-rest for marginal gain).
 *
 * Cadence is dev-friendly: regtest VtxoTreeExpiry is ~17 min, so a 1-min alarm (the
 * MV3 minimum period) with an ~8-min margin renews with comfortable headroom. Both
 * are constants here — bump the margin up toward the mainnet `batchExpiry` window
 * once that value is known (PLAN.md §11 open question).
 */

export const ALARM_RENEWAL = 'arkade:renew';

/** Alarm period. 1 minute is the MV3 floor; fine for regtest's seconds-scale expiry. */
export const RENEWAL_PERIOD_MINUTES = 1;

/**
 * Renew any VTXO expiring within this window. ~8 min sits comfortably inside the
 * ~17-min regtest tree expiry while leaving slack for the batch round to complete.
 */
export const RENEW_MARGIN_MS = 8 * 60 * 1000;

/** Where the last warning is stashed for the popup to read (no secrets — just counts). */
const WARNING_KEY = 'renewalWarning';

/**
 * What the popup shows when coins are expiring while locked. `expiredSats`/`count`
 * are the already-expired (needs-renewal-now) figures; `nextExpiryAtMs` drives the
 * countdown for coins still alive but approaching expiry.
 */
export interface RenewalWarning {
  /** Coins whose expiry has already elapsed (unswept) — most urgent. */
  expiredSats: number;
  count: number;
  /** Soonest upcoming expiry of a still-spendable coin (epoch ms), or null. */
  nextExpiryAtMs: number | null;
  /** When this snapshot was taken (epoch ms). */
  at: number;
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
  | { state: 'unlocked'; renewed: number; txid?: string }
> {
  const seed = getUnlockedSeed();
  if (!seed || !isUnlocked()) {
    // Locked: warn only. Build a read-only view of expiry from the cached VTXO set.
    // We cannot read the live operator without a wallet, but the IndexedDB-backed
    // wallet build needs the seed — so when locked we have no fresh read. Fall back
    // to leaving any prior warning in place (it was written while unlocked).
    const warning = await getRenewalWarning();
    return { state: 'locked', warning };
  }

  // Unlocked: renew, and refresh the warning snapshot for the popup.
  await armAutoLock(); // a renewal tick is activity — keep the session fresh
  const wallet = await buildWallet(seed);
  const result = await renewExpiringVtxos(wallet, RENEW_MARGIN_MS);

  // Re-read post-renewal so the warning reflects the new state (ideally cleared).
  const summary = await getExpiredVtxoSummary(wallet);
  await setRenewalWarning(
    summary.count > 0 || summary.nextExpiryAtMs !== null
      ? { ...summary, at: Date.now() }
      : null,
  );

  return { state: 'unlocked', renewed: result.renewed, txid: result.txid };
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
