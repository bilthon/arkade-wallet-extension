import {
  isExpired,
  isSpendable,
  type ExtendedVirtualCoin,
  type VirtualCoin,
  type WalletBalance,
} from '@arkade-os/sdk';

/**
 * Track F — VTXO expiry/renewal state (the confirmed-bug fix, BUILD_PLAN Track F).
 *
 * Two defects this module addresses (confirmed 2026-06-26):
 *  1. `getBalance().available` counts a VTXO whose batch expiry has elapsed but which
 *     the operator hasn't swept yet (its `virtualStatus.state` is still "settled"/
 *     "preconfirmed", so the SDK's balance sums it into `available`). Our send
 *     pre-check then passes, but `wallet.send`'s coin selection refuses the expired
 *     coin → the raw, opaque "Insufficient funds".
 *  2. With `settlementConfig:false` (Track E) nothing keeps VTXOs alive, so they DO
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
   * Expired-but-not-yet-spent VTXOs the SDK's balance may still be counting. These
   * are the funds that exist but coin selection refuses — the renewal targets.
   */
  expired: ExtendedVirtualCoin[];
  /** Total sats across the expired bucket. */
  expiredSats: number;
}

/**
 * Split the wallet's VTXOs into spendable vs expired-needs-renewal buckets using the
 * SDK's own state helpers. A swept/recoverable coin is also `isExpired`, so it lands
 * in `expired` here — correct, since it is likewise not directly spendable until
 * renewed/recovered.
 */
export function partitionVtxos(vtxos: ExtendedVirtualCoin[]): VtxoPartition {
  const spendable: ExtendedVirtualCoin[] = [];
  const expired: ExtendedVirtualCoin[] = [];
  for (const v of vtxos) {
    if (!isSpendable(v)) continue; // already spent offchain — not our funds anymore
    if (isExpired(v)) expired.push(v);
    else spendable.push(v);
  }
  const expiredSats = expired.reduce((sum, v) => sum + v.value, 0);
  return { spendable, expired, expiredSats };
}

/**
 * Balance breakdown with the expired funds pulled out of the spendable buckets.
 * Extends the SDK shape (so existing consumers keep working) with one honest field:
 * `expired` — sats that exist but need renewal before they can be spent.
 */
export interface AdjustedBalance extends WalletBalance {
  /**
   * Sats in VTXOs whose batch expiry has elapsed but which the operator hasn't swept.
   * Removed from `available`/`settled`/`preconfirmed` (coin selection refuses them)
   * and surfaced here so the UI can show "exists but needs renewal" instead of
   * silently inflating Available.
   */
  expired: number;
  /** Soonest upcoming batch expiry across *spendable* VTXOs (epoch ms), or null. */
  nextExpiryAtMs: number | null;
}

/**
 * Subtract the value of expired-but-still-counted VTXOs from the SDK balance's
 * spendable buckets and surface it as a distinct `expired` figure.
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
  const { spendable, expiredSats } = partitionVtxos(vtxos);

  // Drain the expired sats from preconfirmed first, then settled (clamped at 0 so a
  // mismatch between the indexer's balance and our VTXO sum can never go negative).
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
