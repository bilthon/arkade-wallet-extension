import {
  ArkadeSwaps,
  BoltzSwapProvider,
  IndexedDbSwapRepository,
  isPendingReverseSwap,
  isReverseClaimableStatus,
  isReversePendingStatus,
  isReverseSuccessStatus,
  type BoltzReverseSwap,
  type BoltzSwapStatus,
} from '@arkade-os/boltz-swap';
import type { NetworkName } from '@arkade-os/sdk';
import { getNetwork as getStoredNetwork } from './storage';
import { buildWallet, networkConfig } from './wallet';

/**
 * Lightning deposits (Lightning → Arkade) via Boltz reverse swaps.
 *
 * `ArkadeSwaps` starts a `SwapManager` (WebSocket + failsafe polling) that
 * auto-claims a reverse swap's VHTLC the moment Boltz funds it, so — unlike
 * `buildWallet`, which is cheap and rebuilt per message — we keep ONE instance
 * alive for as long as the wallet stays unlocked: a lazy, unlock-scoped
 * singleton, disposed on lock and on network switch. This mirrors how the
 * seed itself lives in `keystore.ts` module memory: SW alive + unlocked →
 * singleton alive; SW killed → gone, rebuilt on next unlock if needed.
 *
 * Claiming needs the unlocked wallet (our strict lock posture zeroes the seed
 * with the SW), so it only happens while the wallet is unlocked and the SW is
 * alive — in practice while the popup showing the invoice is open. If the
 * user closes the popup before the payment lands, nothing is lost: the swap
 * sits in the per-network `IndexedDbSwapRepository`, and `reconcilePendingSwaps`
 * catches it up on the next unlock. The preimage never crosses the messaging
 * boundary — only the SW / swap repository ever sees it.
 */

// ─── Singleton, scoped to (unlocked, network) ────────────────────────────────

let swaps: ArkadeSwaps | null = null;
let swapsNetwork: NetworkName | null = null;

/** Per-network swap repository name, matching the wallet's own per-network DBs. */
const repoName = (network: NetworkName) => `arkade-swaps-${network}`;

/** Build (or reuse) the `ArkadeSwaps` runtime. Caller guarantees the wallet is unlocked. */
export async function getSwaps(seed: Uint8Array): Promise<ArkadeSwaps> {
  const network = await getStoredNetwork();
  if (swaps && swapsNetwork === network) return swaps;
  await disposeSwaps(); // network changed under us (or nothing built yet) → tear down the old one
  const cfg = networkConfig(network);
  if (!cfg.boltzApiUrl) throw new Error('LIGHTNING_UNAVAILABLE');
  const wallet = await buildWallet(seed);
  swaps = await ArkadeSwaps.create({
    wallet,
    swapProvider: new BoltzSwapProvider({ apiUrl: cfg.boltzApiUrl, network }),
    swapRepository: new IndexedDbSwapRepository(repoName(network)),
    // SwapManager stays on its default (enabled): it auto-claims the moment
    // Boltz funds the VHTLC — no separate wire-up needed here.
  });
  swapsNetwork = network;
  return swaps;
}

/**
 * Called from onLock and switchNetwork. Safe to call when nothing is up.
 *
 * `ArkadeSwaps.dispose()` only stops the SwapManager (WebSocket + timers) — it
 * does NOT close the swap repository's IndexedDB connection, and neither do
 * we. See {@link hasPendingSwaps} for why that's deliberate.
 */
export async function disposeSwaps(): Promise<void> {
  const s = swaps;
  swaps = null;
  swapsNetwork = null;
  if (s) await s.dispose();
}

/**
 * Cheap unlock-time probe: any pending reverse swaps in the repo? (No wallet,
 * no WebSocket — just an IndexedDB read.)
 *
 * Deliberately does NOT dispose the `IndexedDbSwapRepository` it creates.
 * `@arkade-os/sdk`'s `openDatabase`/`closeDatabase` cache IDBDatabase
 * connections in a single PROCESS-WIDE map keyed by db name — disposing this
 * one-off repo would call `closeDatabase(repoName(network))`, which closes
 * and evicts that shared connection for EVERY repository pointing at the same
 * db name, including one a live `ArkadeSwaps` singleton might already be
 * using. Leaving it open is safe and cheap: the SDK's `openDatabase` reuses
 * the cached connection on the next open, the same way `buildWallet`'s own
 * repositories are never explicitly closed either.
 */
export async function hasPendingSwaps(network: NetworkName): Promise<boolean> {
  const repo = new IndexedDbSwapRepository(repoName(network));
  const all = await repo.getAllSwaps();
  return all.some((s) => isPendingReverseSwap(s) && isReversePendingStatus(s.status));
}

/** Unlock-time reconciliation: refresh statuses; the manager auto-claims anything claimable. */
export async function reconcilePendingSwaps(seed: Uint8Array): Promise<void> {
  const s = await getSwaps(seed); // starting the manager already loads pending swaps
  await s.refreshSwapsStatus(); // catch swaps that settled while we were closed
}

// ─── Popup-facing operations ──────────────────────────────────────────────────

/**
 * Availability + form bounds for the Lightning receive tab.
 *
 * Safe to call while LOCKED: builds a bare `BoltzSwapProvider` (no wallet, no
 * seed) and reads its public fee/limit endpoints directly. Returns
 * `available: false` WITHOUT touching the network at all when the active
 * network has no configured Boltz endpoint (Lightning is simply hidden there).
 */
export async function getLightningInfo(): Promise<{
  available: boolean;
  limits?: { min: number; max: number };
  /** Reverse-swap fees for the pre-creation estimate: Boltz percentage (e.g.
   *  0.25 = 0.25%) + fixed miner fees (lockup + claim, already summed). */
  fees?: { percentage: number; minerFeesTotal: number };
}> {
  const network = await getStoredNetwork();
  const cfg = networkConfig(network);
  if (!cfg.boltzApiUrl) return { available: false };

  const provider = new BoltzSwapProvider({ apiUrl: cfg.boltzApiUrl, network });
  const [limits, fees] = await Promise.all([provider.getLimits(), provider.getFees()]);
  return {
    available: true,
    limits: { min: limits.min, max: limits.max },
    fees: {
      percentage: fees.reverse.percentage,
      minerFeesTotal: fees.reverse.minerFees.lockup + fees.reverse.minerFees.claim,
    },
  };
}

/**
 * Create a Lightning invoice for `amount` sats (the INVOICE / sender-side
 * amount — mirrors the library). Unlock-gated: building the swap runtime
 * needs the wallet's claim key.
 */
export async function createInvoice(
  seed: Uint8Array,
  { amount }: { amount: number },
): Promise<{
  invoice: string;
  paymentHash: string;
  swapId: string;
  receiveAmount: number;
  expiresAt: number;
}> {
  const s = await getSwaps(seed);
  const limits = await s.getLimits();
  if (amount < limits.min || amount > limits.max) {
    throw new Error(`Amount must be between ${limits.min} and ${limits.max} sats.`);
  }
  const r = await s.createLightningInvoice({ amount });
  return {
    invoice: r.invoice,
    paymentHash: r.paymentHash,
    swapId: r.pendingSwap.id,
    receiveAmount: r.amount, // sats after Boltz fees
    expiresAt: r.expiry * 1000, // Unix seconds → epoch ms for the countdown UI
    // NOTE: r.preimage deliberately NOT returned — it stays SW-side (it's the claiming secret).
  };
}

/**
 * Pure helper for the popup's fee preview: the invoice (sender-side) amount
 * needed for ~`target` sats to land after Boltz fees. Lives here (not in the
 * popup) so it's unit-testable alongside the other pure functions.
 */
export function invoiceAmountForTarget(
  target: number,
  fees: { percentage: number; minerFeesTotal: number },
): number {
  return Math.ceil((target + fees.minerFeesTotal) / (1 - fees.percentage / 100));
}

export type LnReceiveStatus = 'waiting' | 'claiming' | 'done' | 'expired' | 'failed';

/**
 * Map a raw Boltz reverse-swap status to the popup's UI state. Order matters:
 * `isReverseClaimableStatus` (mempool/confirmed) is a SUBSET of
 * `isReversePendingStatus`, so claimable must be checked first or it would
 * never be reached.
 */
export function mapReverseStatus(status: BoltzSwapStatus): LnReceiveStatus {
  if (isReverseSuccessStatus(status)) return 'done';
  if (status === 'invoice.expired' || status === 'swap.expired') return 'expired';
  if (isReverseClaimableStatus(status)) return 'claiming'; // paid; claim in flight
  if (isReversePendingStatus(status)) return 'waiting';
  return 'failed';
}

/**
 * Read one swap's UI status from the repository (the manager, when running,
 * keeps it fresh). Works even before/without the singleton — no wallet, no
 * unlock needed. See {@link hasPendingSwaps} for why the repo here is never
 * explicitly disposed.
 */
export async function getReceiveStatus(swapId: string): Promise<LnReceiveStatus> {
  const network = await getStoredNetwork();
  const repo = new IndexedDbSwapRepository(repoName(network));
  const [swap] = await repo.getAllSwaps<BoltzReverseSwap>({ id: swapId, type: 'reverse' });
  if (!swap) throw new Error('That Lightning deposit could not be found.');
  return mapReverseStatus(swap.status);
}
