import {
  ArkadeSwaps,
  BoltzSwapProvider,
  IndexedDbSwapRepository,
  isPendingReverseSwap,
  isReverseClaimableStatus,
  isReverseFailedStatus,
  isReversePendingStatus,
  isReverseSuccessStatus,
  type BoltzReverseSwap,
  type BoltzSwapStatus,
} from '@arkade-os/boltz-swap';
import type { NetworkName } from '@arkade-os/sdk';
import { getNetwork as getStoredNetwork } from './storage';
import { buildWallet, networkConfig } from './wallet';
import type { LnReceiveStatus } from './lightning-utils';

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

let swaps: ArkadeSwaps | null = null; // the RESOLVED instance, for dispose
let swapsPromise: Promise<ArkadeSwaps> | null = null; // the in-flight/settled build, memoized
// Bumped by disposeSwaps. Lets a build that was already in flight when a
// lock/switchNetwork happened detect it landed too late and self-destruct
// instead of leaking a live SwapManager (WebSocket + auto-claimer) past the
// seed it was built from. See createRuntime's post-create check.
let generation = 0;

/** Per-network swap repository name, matching the wallet's own per-network DBs. */
const repoName = (network: NetworkName) => `arkade-swaps-${network}`;

/**
 * Build (or reuse) the `ArkadeSwaps` runtime. Caller guarantees the wallet is
 * unlocked.
 *
 * Memoizes the IN-FLIGHT promise, not just the resolved instance, via a
 * synchronous check-and-assign (no `await` before `swapsPromise` is set) —
 * two callers racing this (e.g. the unlock handler's fire-and-forget
 * `reconcilePendingSwaps` racing a user's `createLightningInvoice`) always
 * observe the same in-flight build and get the same instance, rather than
 * both calling `ArkadeSwaps.create` and leaking the loser's SwapManager.
 */
export function getSwaps(seed: Uint8Array): Promise<ArkadeSwaps> {
  if (!swapsPromise) {
    const mine = createRuntime(seed, generation);
    swapsPromise = mine;
    // A failed build must not poison the memo forever — clear it so the next
    // getSwaps retries. Guarded so we never clobber a NEWER promise that a
    // dispose + rebuild (or another failed-then-retried build) may have
    // already installed by the time this settles.
    mine.catch(() => {
      if (swapsPromise === mine) swapsPromise = null;
    });
  }
  return swapsPromise;
}

/**
 * Does the actual build for `getSwaps`. Split out so the memoization above
 * stays synchronous — `createRuntime` is where all the `await`s live.
 *
 * Deliberately does NOT re-read/compare the active network per call the way
 * the old version did: the only code path that ever changes the stored
 * network is the switchNetwork message handler, and it always calls
 * `disposeSwaps()` in the same handler — so a network change is always
 * paired with a generation bump + memo clear, never silently observed by a
 * stale in-flight build. (Confirmed: `setNetwork`/`setVaultAndNetwork` has no
 * other production caller.)
 */
async function createRuntime(seed: Uint8Array, gen: number): Promise<ArkadeSwaps> {
  const network = await getStoredNetwork();
  const cfg = networkConfig(network);
  if (!cfg.boltzApiUrl) throw new Error('LIGHTNING_UNAVAILABLE');
  const wallet = await buildWallet(seed);
  const instance = await ArkadeSwaps.create({
    wallet,
    swapProvider: new BoltzSwapProvider({ apiUrl: cfg.boltzApiUrl, network }),
    swapRepository: new IndexedDbSwapRepository(repoName(network)),
    // SwapManager stays on its default (enabled): it auto-claims the moment
    // Boltz funds the VHTLC — no separate wire-up needed here.
  });

  if (gen !== generation) {
    // A lock (or switchNetwork) landed while `ArkadeSwaps.create` was in
    // flight — this instance may have just been built from a now-zeroed seed
    // or a now-stale network. Self-destruct rather than leak its SwapManager.
    // 'LOCKED' is slightly imprecise for the switchNetwork case, but harmless:
    // the popup routes to unlock, and a network switch requires the password
    // anyway.
    await instance.dispose();
    throw new Error('LOCKED');
  }

  swaps = instance;
  return instance;
}

/**
 * Called from onLock and switchNetwork. Safe to call when nothing is up.
 *
 * Bumps `generation` FIRST, before touching any other state — this is what
 * lets an in-flight `createRuntime` build (started before this call) detect,
 * once it resolves, that it's now stale and dispose itself instead of
 * outliving the seed it was built from.
 *
 * `ArkadeSwaps.dispose()` only stops the SwapManager (WebSocket + timers) — it
 * does NOT close the swap repository's IndexedDB connection, and neither do
 * we. See {@link hasPendingSwaps} for why that's deliberate.
 */
export async function disposeSwaps(): Promise<void> {
  generation++;
  const s = swaps;
  swaps = null;
  swapsPromise = null;
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

/**
 * Unlock-time reconciliation: refresh statuses; the manager auto-claims anything claimable.
 *
 * Called fire-and-forget (`void reconcilePendingSwaps(seed)`) from the unlock
 * handler, so a rejection here has no caller watching for it. A lock racing
 * this call is an expected, harmless case now (see `disposeSwaps`'s
 * generation bump: `getSwaps` rejects with 'LOCKED' when that happens) — swallow
 * it here rather than let it surface as an unhandled promise rejection.
 */
export async function reconcilePendingSwaps(seed: Uint8Array): Promise<void> {
  try {
    const s = await getSwaps(seed); // starting the manager already loads pending swaps
    await s.refreshSwapsStatus(); // catch swaps that settled while we were closed
  } catch {
    /* best-effort recovery — nothing is watching this fire-and-forget call */
  }
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
    // `r.expiry` is a RELATIVE duration in seconds (the raw BOLT11 expiry tag,
    // typically 3600), despite the library docstring calling it a "Unix seconds"
    // timestamp — verified against the compiled 0.3.44 source, where it's the
    // light-bolt11-decoder expiry section passed through untranslated. Anchor it
    // to now (the invoice was created milliseconds ago; the skew is immaterial
    // for a countdown) to get the absolute epoch-ms deadline the UI expects.
    expiresAt: Date.now() + r.expiry * 1000,
    // NOTE: r.preimage deliberately NOT returned — it stays SW-side (it's the claiming secret).
  };
}

/**
 * Map a raw Boltz reverse-swap status to the popup's UI state.
 *
 * Two things this must get right:
 *  - `transaction.claimed` is a SUCCESS for us. Boltz's canonical reverse terminal
 *    is `invoice.settled`, but `claimVHTLC` persists `transaction.claimed` when it
 *    claims a recoverable VHTLC via `joinBatch` (its off-chain claim path instead
 *    reports the Boltz status). Both mean the funds reached us — map to 'done'.
 *  - Unknown statuses must NOT default to 'failed'. Every way the reverse flow can
 *    actually fail is covered by `isReverseFailedStatus` (+ the expired pair); any
 *    other status is a non-reverse/unexpected one, so it falls through to the
 *    non-terminal 'waiting' (which self-heals via invoice expiry) rather than
 *    telling the user "no funds were taken" on a deposit that may well have landed.
 *
 * Order matters: the expired pair is checked before `isReverseFailedStatus` (which
 * also contains them) so they surface as 'expired', not 'failed'.
 */
export function mapReverseStatus(status: BoltzSwapStatus): LnReceiveStatus {
  if (isReverseSuccessStatus(status) || status === 'transaction.claimed') return 'done';
  if (status === 'invoice.expired' || status === 'swap.expired') return 'expired';
  if (isReverseFailedStatus(status)) return 'failed'; // transaction.failed / transaction.refunded
  if (isReverseClaimableStatus(status)) return 'claiming'; // Boltz funded the lockup; claim in flight
  return 'waiting';
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
