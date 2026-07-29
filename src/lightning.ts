import {
  ArkadeSwaps,
  BoltzSwapProvider,
  IndexedDbSwapRepository,
  decodeInvoice,
  hasSubmarineStatusReached,
  isPendingReverseSwap,
  isPendingSubmarineSwap,
  isReverseClaimableStatus,
  isReverseFailedStatus,
  isReversePendingStatus,
  isReverseSuccessStatus,
  isSubmarineFinalStatus,
  isSubmarinePendingStatus,
  isSubmarineRefundableStatus,
  isSubmarineSwapRefundable,
  type BoltzReverseSwap,
  type BoltzSubmarineSwap,
  type BoltzSwapStatus,
} from '@arkade-os/boltz-swap';
import type { NetworkName } from '@arkade-os/sdk';
import { hex } from '@scure/base';
import { getNetwork as getStoredNetwork } from './storage';
import { networkConfig } from './wallet';
import { getSessionWallet, ensureFreshVtxos } from './wallet-runtime';
import { submarineFeeForAmount, type LnPayStatus, type LnReceiveStatus } from './lightning-utils';

/**
 * Lightning deposits (Lightning → Arkade) via Boltz reverse swaps, and
 * Lightning payments (Arkade → Lightning) via Boltz submarine swaps.
 *
 * `ArkadeSwaps` is built on the same shared session wallet every other read
 * and send uses, via `getSessionWallet()` (see `wallet-runtime.ts`). We still
 * keep a SEPARATE Lightning singleton on top of it, though: `ArkadeSwaps`
 * starts a `SwapManager` (WebSocket + failsafe polling) that auto-claims a
 * reverse swap's VHTLC the moment Boltz funds it, and that WebSocket and its
 * timers are not part of the Arkade wallet at all. They need their own
 * lifecycle: built lazily on first use, kept alive for as long as the wallet
 * stays unlocked, and disposed on lock and on network switch. This mirrors the
 * runtime-owned identity: SW alive + unlocked → singleton alive; SW killed →
 * gone, rebuilt on the next unlock if needed.
 *
 * Claiming needs the unlocked wallet (our strict lock posture revokes the live
 * identity with the SW), so it only happens while the wallet is unlocked and the SW is
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
 * Build (or reuse) the `ArkadeSwaps` runtime. The lock check is not the caller's job
 * any more: `getSessionWallet()` reads the live runtime session and throws LOCKED, so
 * a caller that races a lock gets the rejection from there.
 *
 * Memoizes the IN-FLIGHT promise, not just the resolved instance, via a
 * synchronous check-and-assign (no `await` before `swapsPromise` is set) —
 * two callers racing this (e.g. the unlock handler's fire-and-forget
 * `reconcilePendingSwaps` racing a user's `createLightningInvoice`) always
 * observe the same in-flight build and get the same instance, rather than
 * both calling `ArkadeSwaps.create` and leaking the loser's SwapManager.
 */
export function getSwaps(): Promise<ArkadeSwaps> {
  if (!swapsPromise) {
    const mine = createRuntime(generation);
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
async function createRuntime(gen: number): Promise<ArkadeSwaps> {
  const network = await getStoredNetwork();
  const cfg = networkConfig(network);
  if (!cfg.boltzApiUrl) throw new Error('LIGHTNING_UNAVAILABLE');
  const wallet = await getSessionWallet();
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
 * Called from the lock coordinator and switchNetwork. Safe to call when nothing is up.
 *
 * Bumps `generation` FIRST, before touching any other state — this is what
 * lets an in-flight `createRuntime` build (started before this call) detect,
 * once it resolves, that it's now stale and dispose itself instead of
 * outliving the identity it was built from.
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
 * Cheap unlock-time probe: any swaps in the repo still needing work? (No
 * wallet, no WebSocket — just an IndexedDB read.) Pending reverse swaps need
 * claiming; pending submarine swaps need monitoring; failed-but-unrefunded
 * submarine swaps (`isSubmarineSwapRefundable`) need the refund sweep in
 * `reconcilePendingSwaps` — without them here, a payment that failed right
 * before the SW died would never get its funds back.
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
  return all.some(
    (s) =>
      (isPendingReverseSwap(s) && isReversePendingStatus(s.status)) ||
      (isPendingSubmarineSwap(s) &&
        (isSubmarinePendingStatus(s.status) || isSubmarineSwapRefundable(s))),
  );
}

/**
 * Unlock-time reconciliation: refresh statuses; the manager auto-claims anything
 * claimable and auto-refunds anything that FAILS while it's running.
 *
 * The one case the manager can't cover is a submarine swap whose failure status
 * is already FINAL at startup (`invoice.failedToPay` / `swap.expired` persisted,
 * refund not yet done — e.g. the SW died mid-refund): `SwapManager.start` drops
 * final-status swaps from monitoring, so `resumeActionableSwaps` never sees
 * them. Sweep exactly those here via `recoverAllSubmarineFunds` (per-swap error
 * isolation built in). The snapshot is read BEFORE `refreshSwapsStatus` on
 * purpose: a swap whose failure only ARRIVES with the refresh is still
 * monitored, and refunding it is the manager's job — the pre-refresh snapshot
 * keeps the two paths from racing over the same swap. Non-final refundable
 * statuses (`transaction.lockupFailed`) stay with the manager too, hence the
 * `isSubmarineFinalStatus` filter.
 *
 * Called fire-and-forget (`void reconcilePendingSwaps()`) from the unlock
 * handler, so a rejection here has no caller watching for it. A lock racing
 * this call is an expected, harmless case now (see `disposeSwaps`'s
 * generation bump: `getSwaps` rejects with 'LOCKED' when that happens) — swallow
 * it here rather than let it surface as an unhandled promise rejection.
 */
export async function reconcilePendingSwaps(): Promise<void> {
  try {
    const network = await getStoredNetwork();
    const repo = new IndexedDbSwapRepository(repoName(network)); // never disposed — see hasPendingSwaps
    const stranded = (await repo.getAllSwaps()).filter(
      (s): s is BoltzSubmarineSwap =>
        isSubmarineSwapRefundable(s) && isSubmarineFinalStatus(s.status),
    );
    const s = await getSwaps(); // starting the manager already loads pending swaps
    if (stranded.length > 0) await s.recoverAllSubmarineFunds(stranded);
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
export async function createInvoice({ amount }: { amount: number }): Promise<{
  invoice: string;
  paymentHash: string;
  swapId: string;
  receiveAmount: number;
  expiresAt: number;
}> {
  const s = await getSwaps();
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

// ─── Lightning payments (submarine swap: Arkade → Lightning) ─────────────────

/**
 * Decode and price a BOLT11 invoice for the pay-confirm screen.
 * Safe to call while LOCKED, since it only needs the bare provider
 * (same as getLightningInfo).
 *
 * We reject two kinds of invoices here, before the user ever sees a price:
 *   1. Amountless invoices. Boltz can't accept these because the invoice
 *      amount is what ties what Boltz pays out on Lightning to what it's
 *      allowed to claim from the lockup.
 *   2. Invoices outside Boltz's min/max limits (from BoltzSwapProvider.getLimits,
 *      based on the SUBMARINE pair).
 *
 * totalSats is our estimate of what the user will be debited (invoice amount
 * + Boltz fee). It's just an estimate: payInvoice double-checks Boltz's real
 * expectedAmount against it before actually funding, so the user can't end up
 * paying more than this quote said.
 */
export async function getPayQuote({ invoice }: { invoice: string }): Promise<{
  amountSats: number;
  feeSats: number;
  totalSats: number;
  description: string;
}> {
  const network = await getStoredNetwork();
  const cfg = networkConfig(network);
  if (!cfg.boltzApiUrl) throw new Error('Lightning is not available on this network.');

  let decoded: ReturnType<typeof decodeInvoice>;
  try {
    decoded = decodeInvoice(invoice);
  } catch {
    throw new Error("That doesn't look like a valid Lightning invoice.");
  }
  if (decoded.amountSats <= 0) {
    throw new Error(
      'This invoice has no amount. Ask the recipient for an invoice with a fixed amount.',
    );
  }

  const provider = new BoltzSwapProvider({ apiUrl: cfg.boltzApiUrl, network });
  const [limits, fees] = await Promise.all([provider.getLimits(), provider.getFees()]);
  if (decoded.amountSats < limits.min || decoded.amountSats > limits.max) {
    throw new Error(
      `Invoice amount must be between ${limits.min} and ${limits.max} sats.`,
    );
  }

  const feeSats = submarineFeeForAmount(decoded.amountSats, fees.submarine);
  return {
    amountSats: decoded.amountSats,
    feeSats,
    totalSats: decoded.amountSats + feeSats,
    description: decoded.description,
  };
}

/**
 * How many extra sats we'll silently accept when Boltz's actual `expectedAmount`
 * comes in above the total the user confirmed.
 *
 * We do not want to absorb a genuine overcharge, though. The allowance is the
 * larger of two bounds:
 * 1. A flat 10 sats, so tiny invoices still tolerate a few sats of rounding.
 * 2. 0.1% of the invoice, so a large payment can't be inflated by a meaningful
 *    amount before we reject it.
 */
export function payTotalSlack(amountSats: number): number {
  return Math.max(10, Math.ceil(amountSats * 0.001));
}

/**
 * Pay a BOLT11 invoice: create the submarine swap, verify Boltz's asking
 * price against the user-confirmed total, then fund the VHTLC with an Arkade
 * send. Unlock-gated (funding signs).
 *
 * Deliberately NOT `ArkadeSwaps.sendLightningPayment`: that helper funds
 * whatever `expectedAmount` Boltz returns with no way to check it first. This
 * is the same do-not-trust-before-signing posture as `wallet.ts`'s `send` —
 * the guard runs between swap creation and funding, when aborting is free (an
 * unfunded swap just expires; no coins have moved).
 *
 * Returns as soon as the funding tx is accepted ("funded" semantics): the
 * Arkade send is preconfirmed, funds are committed, and from here every
 * outcome is observable via `getPayStatus` polling — Boltz pays the invoice
 * (→ 'paid') or the always-on SwapManager auto-refunds a failure
 * (→ 'refund-pending' → 'refunded'), with `reconcilePendingSwaps` covering
 * swaps the SW didn't live to see through. No preimage crosses back — the
 * popup only ever needs the status.
 */
export async function payInvoice({
  invoice,
  maxTotalSats,
}: {
  invoice: string;
  maxTotalSats: number;
}): Promise<{ swapId: string; txid: string; amountSats: number; totalSats: number }> {
  let decoded: ReturnType<typeof decodeInvoice>;
  try {
    decoded = decodeInvoice(invoice);
  } catch {
    throw new Error("That doesn't look like a valid Lightning invoice.");
  }
  // Defense in depth — the quote already rejected these, but this is the spend path.
  if (decoded.amountSats <= 0) {
    throw new Error(
      'This invoice has no amount. Ask the recipient for an invoice with a fixed amount.',
    );
  }

  const s = await getSwaps();
  const limits = await s.getLimits();
  if (decoded.amountSats < limits.min || decoded.amountSats > limits.max) {
    throw new Error(
      `Invoice amount must be between ${limits.min} and ${limits.max} sats.`,
    );
  }

  // Persisted by the library before we see it, and registered with the running
  // SwapManager — so even if everything after this line dies, reconciliation
  // knows about the swap (an unfunded one is harmless: it just expires).
  const pendingSwap = await s.createSubmarineSwap({ invoice });
  const totalSats = pendingSwap.response.expectedAmount;
  if (!pendingSwap.response.address || !totalSats) {
    throw new Error('The swap service returned an unusable swap. No funds were taken.');
  }
  if (totalSats > maxTotalSats + payTotalSlack(decoded.amountSats)) {
    throw new Error(
      `The swap service now asks for ${totalSats} sats, more than the quoted total. ` +
        'No funds were taken — review the payment again to get a fresh quote.',
    );
  }

  const wallet = await getSessionWallet();

  // Verify the lockup address before we fund it. Boltz returns a VHTLC address for us to send
  // to, but nothing so far proves that address commits to OUR refund key. If it does not, the
  // send is a total loss: the refund path only exists because the VHTLC's refund leaf carries
  // our key, so a wrong address has no way back. We reconstruct the VHTLC from the swap fields
  // and require the address to match, the same pre-funding check the library already runs for
  // chain swaps (verifyChainSwap). This aborts before any funds move.
  const arkInfo = await wallet.arkProvider.getInfo();
  const { claimPublicKey, timeoutBlockHeights } = pendingSwap.response;
  if (!claimPublicKey || !timeoutBlockHeights) {
    throw new Error('The swap service returned an unusable swap. No funds were taken.');
  }
  const { vhtlcAddress } = s.createVHTLCScript({
    network: arkInfo.network,
    preimageHash: hex.decode(decoded.paymentHash),
    receiverPubkey: claimPublicKey, // Boltz's claim key
    senderPubkey: pendingSwap.request.refundPublicKey, // our refund key, the only way back
    serverPubkey: arkInfo.signerPubkey, // current Arkade signer, fresh swap so no rotation
    timeoutBlockHeights,
  });
  if (vhtlcAddress !== pendingSwap.response.address) {
    throw new Error(
      'The swap service returned a lockup address we could not verify. No funds were taken.',
    );
  }

  // Coin selection needs a live view of what's spendable. Building the wallet used to
  // give us that for free, because construction ran a delta sync. The shared session
  // wallet does not, so we refresh explicitly right before the send that selects coins.
  await ensureFreshVtxos(wallet);

  let txid: string;
  try {
    txid = await wallet.send({ address: pendingSwap.response.address, amount: totalSats });
  } catch (err) {
    // Same opaque-message translation as wallet.ts's send path. The unfunded
    // swap left behind expires harmlessly.
    if (err instanceof Error && /insufficient funds/i.test(err.message)) {
      throw new Error(
        `Not enough spendable balance to cover the ${totalSats}-sat total (invoice + fees).`,
      );
    }
    throw err;
  }

  return { swapId: pendingSwap.id, txid, amountSats: decoded.amountSats, totalSats };
}

/**
 * Map a submarine swap record to the popup's UI state.
 *
 * Needs the record, not just the status: after the manager (or reconcile)
 * refunds a failed swap, the terminal Boltz status STAYS `invoice.failedToPay`
 * / `swap.expired` — "the money came back" only exists as the persisted
 * `refunded` flag, so that's checked first. `hasSubmarineStatusReached` treats
 * any status at/past `invoice.paid` as paid — the recipient has the money from
 * `invoice.paid` on; Boltz sweeping its side (`transaction.claimed`) is not the
 * user's concern. Unknown/non-submarine statuses fall through to the
 * non-terminal 'sending' (the manager/reconcile drive every real failure to a
 * refund), mirroring `mapReverseStatus`'s never-default-to-failed rule.
 */
export function mapSubmarineStatus(
  swap: Pick<BoltzSubmarineSwap, 'status' | 'refunded'>,
): LnPayStatus {
  if (swap.refunded || swap.status === 'transaction.refunded') return 'refunded';
  if (isSubmarineRefundableStatus(swap.status)) return 'refund-pending';
  if (hasSubmarineStatusReached(swap.status, 'invoice.paid')) return 'paid';
  return 'sending';
}

/**
 * Read one payment's UI status from the repository (the manager, when running,
 * keeps it fresh). Works even before/without the singleton — no wallet, no
 * unlock needed. See {@link hasPendingSwaps} for why the repo here is never
 * explicitly disposed.
 */
export async function getPayStatus(swapId: string): Promise<LnPayStatus> {
  const network = await getStoredNetwork();
  const repo = new IndexedDbSwapRepository(repoName(network));
  const [swap] = await repo.getAllSwaps<BoltzSubmarineSwap>({ id: swapId, type: 'submarine' });
  if (!swap) throw new Error('That Lightning payment could not be found.');
  return mapSubmarineStatus(swap);
}
