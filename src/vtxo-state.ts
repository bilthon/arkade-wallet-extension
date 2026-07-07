import {
  isExpired,
  isRecoverable,
  isSpendable,
  type ExtendedVirtualCoin,
  type VirtualCoin,
  type WalletBalance,
} from '@arkade-os/sdk';

/**
 * VTXO expiry/renewal state (the confirmed-bug fix).
 *
 * Two defects this module addresses:
 *  1. `getBalance().available` counts a VTXO whose batch expiry has elapsed but which
 *     the operator hasn't swept yet (its `virtualStatus.state` is still "settled"/
 *     "preconfirmed", so the SDK's balance sums it into `available`). Our send
 *     pre-check then passes, but `wallet.send`'s coin selection refuses the expired
 *     coin → the raw, opaque "Insufficient funds".
 *  2. With `settlementConfig:false` nothing keeps VTXOs alive, so they DO
 *     expire. The renewal scheduler (renewal.ts) drives the deliberate fix; this
 *     module supplies the pure state math both the balance fix and the scheduler need.
 *
 * Everything here is pure (no wallet/operator/clock-side-effects beyond `Date.now`
 * inside the SDK's `isExpired`), so it is unit-tested directly with synthetic VTXOs.
 *
 * `isExpired` (SDK): true when state==="swept" OR `batchExpiry` (a ms timestamp) has
 * passed. It deliberately ignores obviously-non-time values (block heights), so on
 * regtest a height-encoded expiry won't trip a false positive. `isSpendable`: not
 * yet spent offchain. We treat "expired but still spendable and not swept" as the
 * needs-renewal bucket — funds that exist but coin selection will refuse.
 */

/** A coin's expiry timestamp in epoch-ms, or null when the batch expiry is unknown. */
export function expiresAtMs(vtxo: VirtualCoin): number | null {
  const expiry = vtxo.virtualStatus.batchExpiry;
  if (!expiry) return null;
  // Mirror the SDK's guard: a value whose year is < 2025 is a block height, not a
  // timestamp (regtest), and carries no wall-clock expiry we can count down to.
  if (new Date(expiry).getFullYear() < 2025) return null;
  return expiry;
}

export interface VtxoPartition {
  /** Spendable now: not spent, not expired. Their value is the *true* available. */
  spendable: ExtendedVirtualCoin[];
  /**
   * Time-expired-but-not-yet-swept VTXOs (batch expiry elapsed, `state` still
   * "settled"/"preconfirmed"). The SDK's `getBalance()` STILL sums these into
   * `available`, yet coin selection refuses them — so these are the ones we must
   * drain from `available`. They are renewed via `renewVtxos` (still valid coins).
   */
  expired: ExtendedVirtualCoin[];
  /** Total sats across the time-expired-but-unswept bucket (the `available` drain). */
  expiredSats: number;
  /**
   * Swept/recoverable VTXOs (`state === "swept"`, still spendable). The SDK already
   * accounts for these in `WalletBalance.recoverable` and NEVER in `available`, so we
   * must NOT subtract them again. Surfaced separately to drive the Recover action;
   * these need `recoverVtxos`, not `renewVtxos`.
   */
  recoverable: ExtendedVirtualCoin[];
  /** Total sats across the swept/recoverable bucket. */
  recoverableSats: number;
}

/**
 * Split the wallet's VTXOs into spendable / time-expired-unswept / swept-recoverable
 * buckets using the SDK's own state helpers.
 *
 * The swept-vs-time-expired split is load-bearing for the balance fix: the SDK's
 * `getBalance()` already moves swept coins out of `available` into `recoverable`, but a
 * coin whose `batchExpiry` merely *elapsed* (state still "settled"/"preconfirmed") is
 * still counted in `available` even though coin selection refuses it. Only the latter
 * may be drained from `available`; re-subtracting swept coins would double-count them.
 */
export function partitionVtxos(vtxos: ExtendedVirtualCoin[]): VtxoPartition {
  const spendable: ExtendedVirtualCoin[] = [];
  const expired: ExtendedVirtualCoin[] = [];
  const recoverable: ExtendedVirtualCoin[] = [];
  for (const v of vtxos) {
    if (!isSpendable(v)) continue; // already spent offchain — not our funds anymore
    if (isRecoverable(v)) {
      // Swept but still spendable → the SDK's `recoverable` bucket; recover, don't renew.
      recoverable.push(v);
    } else if (isExpired(v)) {
      // batchExpiry elapsed but not yet swept → still in `available`, must be drained.
      expired.push(v);
    } else {
      spendable.push(v);
    }
  }
  const expiredSats = expired.reduce((sum, v) => sum + v.value, 0);
  const recoverableSats = recoverable.reduce((sum, v) => sum + v.value, 0);
  return { spendable, expired, expiredSats, recoverable, recoverableSats };
}

/**
 * The message shown when a coin the user picked can no longer be found among the live
 * spendable set. The popup only ever sends outpoints it just listed, so a miss means the
 * coin changed state in the background (renewed, spent, or swept) between listing and
 * spending. One source of truth so the deterministic (pick) and raced (send) cases read
 * the same.
 */
export const COIN_GONE_MESSAGE =
  'A selected coin is no longer spendable (it may have been renewed). Go back, reselect, and try again.';

/** The "txid:vout" outpoint string that identifies a coin across the popup boundary. */
export function outpointOf(vtxo: VirtualCoin): string {
  return `${vtxo.txid}:${vtxo.vout}`;
}

/**
 * Resolve "txid:vout" outpoint strings back to live coins, in the order given.
 *
 * Callers pass only the spendable bucket, so a coin that has since expired or been swept
 * simply won't be found and reads as a miss. Any miss throws {@link COIN_GONE_MESSAGE} —
 * we never spend a partial selection.
 */
export function pickByOutpoints(
  vtxos: ExtendedVirtualCoin[],
  outpoints: string[],
): ExtendedVirtualCoin[] {
  const byOutpoint = new Map(vtxos.map((v) => [outpointOf(v), v]));
  return outpoints.map((op) => {
    const coin = byOutpoint.get(op);
    if (!coin) throw new Error(COIN_GONE_MESSAGE);
    return coin;
  });
}

/**
 * Balance breakdown with the expired funds pulled out of the spendable buckets.
 * Extends the SDK shape (so existing consumers keep working) with one honest field:
 * `expired` — sats that exist but need renewal before they can be spent.
 */
export interface AdjustedBalance extends WalletBalance {
  /**
   * Sats in VTXOs whose batch expiry has elapsed but which the operator hasn't swept
   * (state still "settled"/"preconfirmed"). Removed from `available`/`settled`/
   * `preconfirmed` (coin selection refuses them) and surfaced here so the UI can show
   * "exists but needs renewal" instead of silently inflating Available. Renewed via
   * `renewVtxos` — these coins are still valid, just close to / past their soft expiry.
   */
  expired: number;
  /**
   * Sats in swept VTXOs (`state === "swept"`, still spendable). These are ALREADY in
   * the SDK's `recoverable` field and never in `available`, so they are NOT drained
   * again here — this mirrors the SDK figure for the "needs recovery" UI bucket and
   * drives the Recover action (`recoverVtxos`, distinct from renewal).
   */
  recoverableSats: number;
  /** Soonest upcoming batch expiry across *spendable* VTXOs (epoch ms), or null. */
  nextExpiryAtMs: number | null;
}

/**
 * Subtract only the time-expired-but-unswept VTXOs from the SDK balance's spendable
 * buckets and surface them as a distinct `expired` figure. Swept (recoverable) coins
 * are LEFT ALONE: the SDK already excludes them from `available` and counts them in
 * `recoverable`, so re-subtracting them here would understate `available` whenever a
 * live spendable coin co-exists with a swept one. We mirror the swept value into
 * `recoverableSats` for the "needs recovery" UI bucket instead of draining it.
 *
 * The SDK does not tell us how the expired value is distributed across
 * settled/preconfirmed, so we drain `preconfirmed` first then `settled` (preconfirmed
 * is the less-final bucket, so this is the conservative attribution) and recompute
 * `available = settled + preconfirmed`. `total` is left untouched — the funds still
 * exist; they're just not spendable until renewed.
 */
export function adjustBalanceForExpiry(
  balance: WalletBalance,
  vtxos: ExtendedVirtualCoin[],
): AdjustedBalance {
  const { spendable, expiredSats, recoverableSats } = partitionVtxos(vtxos);

  // Drain ONLY the time-expired-but-unswept sats from preconfirmed first, then settled
  // (clamped at 0 so a mismatch between the indexer's balance and our VTXO sum can
  // never go negative). Swept/recoverable coins are not touched — the SDK already kept
  // them out of available.
  const preconfirmed = Math.max(0, balance.preconfirmed - expiredSats);
  const drainedFromPreconf = balance.preconfirmed - preconfirmed;
  const stillToDrain = expiredSats - drainedFromPreconf;
  const settled = Math.max(0, balance.settled - Math.max(0, stillToDrain));

  return {
    ...balance,
    settled,
    preconfirmed,
    available: settled + preconfirmed,
    expired: expiredSats,
    // Prefer the SDK's own `recoverable` figure (authoritative); fall back to our VTXO
    // sum if the SDK left it at 0 but we observed swept coins (defensive).
    recoverableSats: balance.recoverable > 0 ? balance.recoverable : recoverableSats,
    nextExpiryAtMs: soonestExpiry(spendable),
  };
}

/** Soonest upcoming batch expiry (epoch ms) across the given VTXOs, or null. Drives
 *  the "next renewal due in …" countdown in the wallet home. */
export function soonestExpiry(vtxos: VirtualCoin[]): number | null {
  let soonest: number | null = null;
  for (const v of vtxos) {
    const at = expiresAtMs(v);
    if (at === null) continue;
    if (soonest === null || at < soonest) soonest = at;
  }
  return soonest;
}
