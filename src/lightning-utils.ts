/**
 * Pure, dependency-free Lightning helpers shared by the popup and the background SW.
 *
 * Kept OUT of `lightning.ts` — which statically imports the heavy
 * `@arkade-os/boltz-swap` swap runtime (and, transitively, the SDK + bitcoin
 * crypto) — so the popup can use these without any risk of that library being
 * pulled into its bundle. The separation is STRUCTURAL: the popup importing from
 * here can never drag in the runtime, whereas importing the same helper from
 * `lightning.ts` only stays out of the popup bundle as long as tree-shaking happens
 * to eliminate an otherwise-live top-level import. Don't add non-pure imports here.
 */

/** UI-facing status for a Lightning (reverse-swap) deposit. */
export type LnReceiveStatus = 'waiting' | 'claiming' | 'done' | 'expired' | 'failed';

/**
 * Fee preview helper: the invoice (sender-side) amount needed for ~`target` sats to
 * land after Boltz fees. Unit-tested in `lightning.test.ts`.
 */
export function invoiceAmountForTarget(
  target: number,
  fees: { percentage: number; minerFeesTotal: number },
): number {
  return Math.ceil((target + fees.minerFeesTotal) / (1 - fees.percentage / 100));
}
