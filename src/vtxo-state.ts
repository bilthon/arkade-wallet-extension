import {
  isExpired,
  isRecoverable,
  isSpendable,
  type ExtendedVirtualCoin,
  type VirtualCoin,
  type WalletBalance,
} from '@arkade-os/sdk';

/**
 * VTXO expiry and renewal state.
 *
 * What this module does, and what it stopped needing to do:
 *  1. SDK 0.4.62 keeps an expired VTXO out of `available` by itself. Swept coins and
 *     coins whose batch expiry merely elapsed both land in the SDK's `recoverable`
 *     figure. Up to 0.4.39 the elapsed-but-unswept ones were still counted as
 *     available and we subtracted them here. We no longer do, because subtracting a
 *     second time would understate what the wallet can spend.
 *  2. The SDK reports those two cases as one number, and we split them again. Both are
 *     restored by the same call, `recoverVtxos` (see `renewExpiringVtxos` in wallet.ts),
 *     so the split is not about picking an action. It is about reporting: coin control
 *     labels each coin, and the locked-wallet warning counts the two separately.
 *  3. With `settlementConfig:false` nothing keeps VTXOs alive, so they do expire. The
 *     renewal scheduler (renewal.ts) drives the deliberate fix. This module supplies
 *     the pure state math that scheduler needs.
 *
 * Everything here is pure (no wallet, operator, or clock side effects beyond
 * `Date.now` inside the SDK's `isExpired`), so we unit-test it with synthetic VTXOs.
 *
 * The SDK helpers we build on: `isExpired` is true when a coin is swept or its expiry
 * timestamp has passed, and it ignores block-height values so a regtest height never
 * reads as expired. `isRecoverable` is true only when the coin is swept. `isSpendable`
 * is true until the coin is spent offchain.
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
   * VTXOs whose batch expiry elapsed but which the operator has not swept yet. The
   * SDK counts these in `recoverable` and not in `available`, so there is nothing to
   * subtract. Restoring them means `recoverVtxos`, never `renewVtxos`: feeding an
   * already-expired coin to renew is what triggered INVALID_INTENT_PROOF.
   */
  expired: ExtendedVirtualCoin[];
  /** Total sats across the elapsed-but-unswept bucket. */
  expiredSats: number;
  /**
   * Swept VTXOs that are not yet spent. The SDK counts these in `recoverable` too,
   * alongside the elapsed-but-unswept ones, so that one field cannot tell the two
   * apart. Restored by the same `recoverVtxos` call as the bucket above. We keep them
   * separate so the coin list can label each coin and the warning can count both.
   */
  recoverable: ExtendedVirtualCoin[];
  /** Total sats across the swept/recoverable bucket. */
  recoverableSats: number;
}

/**
 * Split the wallet's VTXOs into spendable, elapsed-but-unswept, and swept buckets
 * using the SDK's own state helpers.
 *
 * The split exists because the SDK's `recoverable` figure covers the last two buckets
 * together, and they are fixed by different calls. Test order below is load-bearing:
 * `isExpired` is also true for a swept coin, so we ask `isRecoverable` first.
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
      // Expiry elapsed but the operator has not swept it. Still valid, so renew it.
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
 * The SDK balance plus the two figures the UI needs and the SDK does not separate.
 * We only add fields, so every existing consumer keeps working.
 */
export interface AdjustedBalance extends WalletBalance {
  /**
   * Sats in VTXOs whose batch expiry elapsed but which the operator has not swept.
   * The SDK already keeps these out of `available` and counts them in `recoverable`.
   * We report them here so the wallet home can show funds that exist but cannot be
   * spent until recovered.
   */
  expired: number;
  /**
   * Sats in swept VTXOs that are not yet spent. We sum this from the VTXOs rather than
   * reading the SDK's `recoverable`, because that field is this bucket plus `expired`.
   * The wallet home adds the two together, so reading the field would count the
   * expired coins twice.
   */
  recoverableSats: number;
  /** Soonest upcoming batch expiry across *spendable* VTXOs (epoch ms), or null. */
  nextExpiryAtMs: number | null;
}

/**
 * Add the expiry breakdown to the SDK balance and change none of its own figures.
 *
 * We pass `available`, `settled`, and `preconfirmed` straight through, for two reasons:
 *  1. Since SDK 0.4.62 `available` already excludes both expired and swept coins.
 *     Subtracting them again here would understate what the wallet can spend.
 *  2. `settled` and `preconfirmed` say how final a coin is, not whether it can be
 *     spent. They now include funds locked in a contract, such as a Lightning swap
 *     lockup. `available` is the only field that answers "can I spend this now".
 */
export function adjustBalanceForExpiry(
  balance: WalletBalance,
  vtxos: ExtendedVirtualCoin[],
): AdjustedBalance {
  const { spendable, expiredSats, recoverableSats } = partitionVtxos(vtxos);

  return {
    ...balance,
    expired: expiredSats,
    recoverableSats,
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
