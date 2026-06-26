import {
  Wallet,
  SeedIdentity,
  ArkAddress,
  Ramps,
  networks,
  isExpired,
  isRecoverable,
  isSpendable,
  isVtxoExpiringSoon,
  IndexedDBWalletRepository,
  IndexedDBContractRepository,
  type NetworkName,
  type WalletBalance,
  type ExtendedVirtualCoin,
} from '@arkade-os/sdk';
import { getNetwork as getStoredNetwork } from './storage';
import {
  adjustBalanceForExpiry,
  partitionVtxos,
  soonestExpiry,
  type AdjustedBalance,
} from './vtxo-state';

/**
 * Track C — SDK wallet runtime (PLAN.md §2, BUILD_PLAN Track C).
 *
 * The MV3 background SW is a STATELESS router: it holds no live `Wallet` between
 * wakes. `buildWallet(seed)` re-creates one on each wake from the in-memory seed
 * (held only in `keystore.ts`, M1) + the IndexedDB repositories (where the SDK has
 * already persisted VTXO/balance/history state). Construction is therefore cheap —
 * the durable state lives in IndexedDB and survives SW restarts (PLAN.md §10).
 *
 * Read-only scope only: addresses, balances, pubkey, network. NO send/sign/settle/
 * delegation here — those land in Phase 3+ (Tracks E/F).
 */

// ─── Network → operator/esplora config (PLAN.md §4) ──────────────────────────

export interface NetworkConfig {
  /** Arkade operator (arkd) REST base. */
  arkServerUrl: string;
  /** Esplora REST base for on-chain (boarding) UTXO lookups. */
  esploraUrl: string;
  /** BIP86 coin type: mainnet (0') vs everything else (1'). Drives derivation. */
  isMainnet: boolean;
}

/**
 * Endpoints per network (PLAN.md §4 table). Switched together — operator + esplora.
 * Boltz/delegate URLs are intentionally absent here (Tracks F/G); this is read-only.
 *
 * ponytail: regtest points at nigiri's local services. arkd on :7070, electrs REST
 * on :30000 — verified reachable from the SW (NOT chopsticks :3000, which is not the REST base).
 */
export const NETWORK_CONFIG: Record<NetworkName, NetworkConfig> = {
  regtest: {
    arkServerUrl: 'http://localhost:7070',
    esploraUrl: 'http://localhost:30000',
    isMainnet: false,
  },
  mutinynet: {
    arkServerUrl: 'https://mutinynet.arkade.sh',
    esploraUrl: 'https://mutinynet.com/api',
    isMainnet: false,
  },
  signet: {
    arkServerUrl: 'https://signet.arkade.sh',
    esploraUrl: 'https://mempool.space/signet/api',
    isMainnet: false,
  },
  testnet: {
    arkServerUrl: 'https://testnet.arkade.sh',
    esploraUrl: 'https://mempool.space/testnet/api',
    isMainnet: false,
  },
  bitcoin: {
    arkServerUrl: 'https://arkade.computer',
    esploraUrl: 'https://mempool.space/api',
    isMainnet: true,
  },
};

/** Resolve the config for a network name. Throws on an unknown name. */
export function networkConfig(network: NetworkName): NetworkConfig {
  const cfg = NETWORK_CONFIG[network];
  if (!cfg) throw new Error(`wallet: no config for network "${network}"`);
  return cfg;
}

// ─── buildWallet — per-wake rehydration ──────────────────────────────────────

/**
 * Rehydrate a `Wallet` from the in-memory seed and the active network's config,
 * backed by IndexedDB repositories. Called by every read handler on each SW wake.
 *
 * The seed is BIP86-derived for the active network (coin type 0' mainnet / 1'
 * otherwise) via `SeedIdentity.fromSeed` — the canonical seed-first factory
 * (symmetric with `MnemonicIdentity.fromMnemonic`), so the keystore never has to
 * hand the mnemonic across.
 */
export async function buildWallet(seed: Uint8Array): Promise<Wallet> {
  const network = await getStoredNetwork();
  const cfg = networkConfig(network);
  const identity = SeedIdentity.fromSeed(seed, { isMainnet: cfg.isMainnet });
  return Wallet.create({
    identity,
    // arkServerUrl/esploraUrl are @deprecated in favor of explicit providers, but
    // PLAN.md §2/§4 calls them out by name and they still resolve to Rest/Esplora
    // providers under the hood. Keep the URL form until we need provider injection.
    arkServerUrl: cfg.arkServerUrl,
    esploraUrl: cfg.esploraUrl,
    // IndexedDB repos = the durability mechanism (survives SW restarts). Omitting
    // storage would default to in-memory and lose all state on every SW kill.
    storage: {
      walletRepository: new IndexedDBWalletRepository(),
      contractRepository: new IndexedDBContractRepository(),
    },
    // settlementConfig: false makes the wallet DELIBERATE — no background signing.
    //
    // With neither settlementConfig nor renewalConfig, the SDK falls back to
    // DEFAULT_SETTLEMENT_CONFIG (boardingUtxoSweep + 60s poll) and `Wallet.create`
    // eagerly starts a VtxoManager poll that auto-settles (onboards) new boarding
    // UTXOs into VTXOs and auto-renews on `vtxo_received` — all with NO user action.
    // That is why the read-only Track-C wallet silently onboarded funds. A per-wake
    // stateless SW wallet must not sign in the background, and Track E's explicit
    // sends must be the only signing path. Deliberate renewal/delegation is Track F's
    // job and will opt back in via `delegateProvider` / an explicit settlementConfig.
    settlementConfig: false,
  });
}

// ─── Read methods (operate on a built wallet) ────────────────────────────────

/** Operator-bound Arkade address (`ark`/`tark…`) — NOT a plain BIP86 P2TR (PLAN.md §6). */
export function getAddress(wallet: Wallet): Promise<string> {
  return wallet.getAddress();
}

/** On-chain boarding address — receives normal UTXOs, later onboarded to VTXOs (PLAN.md §6). */
export function getBoardingAddress(wallet: Wallet): Promise<string> {
  return wallet.getBoardingAddress();
}

/**
 * Full balance breakdown, corrected for expired-but-unswept VTXOs (Track F bug fix).
 *
 * The raw `wallet.getBalance()` counts a VTXO whose batch expiry has elapsed but
 * which the operator hasn't swept (state still "settled"/"preconfirmed") into
 * `available` — yet `wallet.send`'s coin selection refuses it. We re-read the VTXO
 * set, partition out the expired ones via the SDK's `isExpired`/`isSpendable`, and
 * subtract their value from `available`/`settled`/`preconfirmed`, surfacing it as a
 * distinct `expired` bucket plus the soonest upcoming expiry (for the countdown UI).
 *
 * `getVtxos({ withRecoverable: true })` is needed so swept (recoverable) coins are
 * visible and correctly excluded from spendable rather than silently inflating it.
 */
export async function getBalance(wallet: Wallet): Promise<AdjustedBalance> {
  const [balance, vtxos] = await Promise.all([
    wallet.getBalance(),
    wallet.getVtxos({ withRecoverable: true }),
  ]);
  return adjustBalanceForExpiry(balance, vtxos);
}

/** The active network name (from storage; addresses are operator-bound to it). */
export function getNetwork(): Promise<NetworkName> {
  // The wallet's operator is fixed by this at build time; re-exposed here so the
  // provider/messaging layer reads the network through the wallet read-method surface.
  return getStoredNetwork();
}

/**
 * Persist the active network. The next `buildWallet` picks up the new operator →
 * a different Arkade address (operator is baked into the address; PLAN.md §6).
 * ponytail: no interactive picker UI yet (read-only pill); this exists for Track F
 * and the settings screen to call, and for completeness of the wallet surface.
 */
export { setNetwork } from './storage';

/**
 * Raw user key as hex — x-only (32B) + compressed (33B). Exposed for dapps that
 * build their own VtxoScripts (escrow/HTLC); the operator-bound Arkade address
 * encodes a *tweaked* output key, not this raw key (PLAN.md §8). No UI; just exposed.
 */
export async function getPublicKey(
  wallet: Wallet,
): Promise<{ xOnly: string; compressed: string }> {
  const identity = wallet.identity;
  const [xOnly, compressed] = await Promise.all([
    identity.xOnlyPublicKey(),
    identity.compressedPublicKey(),
  ]);
  return { xOnly: toHex(xOnly), compressed: toHex(compressed) };
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ─── Off-chain send: validation + send (Track E) ──────────────────────

/**
 * Dust floor for an Arkade send, in sats. 330 is the standard P2TR dust threshold
 * (the Arkade VTXO output is a taproot output). Amounts below this can't be
 * represented as a normal (non-subdust) output, so we reject them up front rather
 * than letting the operator fail the send.
 */
export const DUST_SATS = 330;

/** A validation failure the popup can render verbatim. `code` lets the UI branch. */
export class SendValidationError extends Error {
  constructor(
    readonly code:
      | 'ADDRESS_ONCHAIN'
      | 'ADDRESS_WRONG_NETWORK'
      | 'ADDRESS_MALFORMED'
      | 'AMOUNT_NOT_INTEGER'
      | 'AMOUNT_TOO_LOW'
      | 'AMOUNT_BELOW_DUST'
      | 'AMOUNT_EXCEEDS_BALANCE',
    message: string,
  ) {
    super(message);
    this.name = 'SendValidationError';
  }
}

/** The bech32 HRPs of on-chain Bitcoin addresses, by network — used to give a
 * precise "this is on-chain, use offboard" message instead of a generic reject. */
function onchainPrefixFor(network: NetworkName): string {
  // networks[*].bech32 is the segwit HRP: bc / tb / bcrt.
  return networks[network].bech32;
}

/**
 * Validate that `address` is a well-formed Arkade address for the ACTIVE network.
 *
 * Arkade addresses are operator-bound bech32m with a network HRP: `ark` (mainnet)
 * vs `tark` (testnet/signet/mutinynet/regtest) — sourced from `networks[network].hrp`,
 * not hardcoded. We:
 *   1. Reject an on-chain `bc1…`/`tb1…`/`bcrt1…` with a clear "offboard is separate".
 *   2. Decode as an Arkade address (throws on malformed / wrong format).
 *   3. Require the decoded HRP to match the active network's HRP (no cross-network
 *      sends — a `tark…` address is meaningless to a mainnet operator and vice-versa).
 *
 * Throws `SendValidationError` with a user-facing message; returns nothing on success.
 */
export function validateArkadeAddress(address: string, network: NetworkName): void {
  const trimmed = address.trim();
  if (!trimmed) {
    throw new SendValidationError('ADDRESS_MALFORMED', 'Enter an Arkade address.');
  }

  // 1) On-chain address → explicit, non-silent rejection (PLAN.md §6 — offboard is
  //    a separate, later flow; never silently route an Arkade send on-chain).
  const onchainHrp = onchainPrefixFor(network);
  const lower = trimmed.toLowerCase();
  const looksOnchain =
    lower.startsWith(`${onchainHrp}1`) ||
    lower.startsWith('bc1') ||
    lower.startsWith('tb1') ||
    lower.startsWith('bcrt1');
  if (looksOnchain) {
    throw new SendValidationError(
      'ADDRESS_ONCHAIN',
      'That looks like an on-chain Bitcoin address. On-chain withdrawals are a separate flow coming soon — this screen only sends to Arkade addresses.',
    );
  }

  // 2) Decode as an Arkade address. `ArkAddress.decode` throws on anything malformed.
  let decoded: ArkAddress;
  try {
    decoded = ArkAddress.decode(trimmed);
  } catch {
    throw new SendValidationError(
      'ADDRESS_MALFORMED',
      "That doesn't look like a valid Arkade address.",
    );
  }

  // 3) HRP must match the active network's expected Arkade HRP.
  const expectedHrp = networks[network].hrp;
  if (decoded.hrp !== expectedHrp) {
    throw new SendValidationError(
      'ADDRESS_WRONG_NETWORK',
      `That address is for a different network (expected a "${expectedHrp}…" address).`,
    );
  }
}

/**
 * Validate the amount in sats against the dust floor and the live available balance.
 * `available` is `getBalance().available` (the only spendable bucket for an off-chain
 * Arkade→Arkade send). Throws `SendValidationError`; returns nothing on success.
 */
export function validateAmount(amount: number, available: number): void {
  if (!Number.isInteger(amount)) {
    throw new SendValidationError('AMOUNT_NOT_INTEGER', 'Enter a whole number of sats.');
  }
  if (amount <= 0) {
    throw new SendValidationError('AMOUNT_TOO_LOW', 'Enter an amount greater than zero.');
  }
  if (amount < DUST_SATS) {
    throw new SendValidationError(
      'AMOUNT_BELOW_DUST',
      `Amount is below the ${DUST_SATS}-sat minimum.`,
    );
  }
  if (amount > available) {
    throw new SendValidationError(
      'AMOUNT_EXCEEDS_BALANCE',
      `Amount exceeds your available balance (${available} sats).`,
    );
  }
}

/**
 * Off-chain Arkade→Arkade send. Validates the address (active network) and amount
 * (dust + live available balance) BEFORE signing, then calls the SDK's
 * `wallet.send({ address, amount })` — instant, ~zero fee, no L1 footprint
 * (PLAN.md §6 regime 1). Returns the txid the SDK gives.
 *
 * On-chain (`bc1…`) and Lightning are deliberately NOT routed here — they map to
 * `Ramps.offboard` / Boltz with their own approval UX (separate, later PRs).
 */
export async function send(
  wallet: Wallet,
  { address, amount }: { address: string; amount: number },
): Promise<{ txid: string }> {
  const network = await getStoredNetwork();
  validateArkadeAddress(address, network);

  // Validate the amount against the LIVE *expiry-adjusted* available balance (not the
  // raw SDK balance, which over-counts expired coins). This is the pre-check that now
  // catches the expired-coin case up front (AMOUNT_EXCEEDS_BALANCE → "…available
  // balance") instead of letting the SDK throw its opaque "Insufficient funds".
  const balance = await getBalance(wallet);
  validateAmount(amount, balance.available);

  // A single Recipient { address, amount } is the off-chain Arkade→Arkade case.
  try {
    const txid = await wallet.send({ address: address.trim(), amount });
    return { txid };
  } catch (err) {
    // Defense in depth: if coin selection still refuses (e.g. a coin expired in the
    // window between our pre-check and the send), translate the raw SDK message into
    // the human one rather than leaking "Insufficient funds".
    if (err instanceof Error && /insufficient funds/i.test(err.message)) {
      throw new Error(
        balance.expired > 0
          ? 'Some of your coins have expired and need renewal before they can be spent. Unlock and renew, then try again.'
          : 'Not enough spendable balance to cover this send.',
      );
    }
    throw err;
  }
}

// ─── Renewal + onboarding (Track F — deliberate, unlock-gated liveness) ───────

/**
 * Translate a raw batch-settle / intent error into a human, non-fatal message.
 *
 * Renewal, recovery, and onboarding all drive a batch swap (`settle`) under the hood,
 * which registers a pre-signed BIP322 intent with the operator. Two failure modes leak
 * opaque protocol text we must not rethrow verbatim:
 *
 *  • `INVALID_INTENT_PROOF (23): no matching intents found` — the inputs we tried to
 *    settle don't match a registered intent. The classic trigger (the runtime bug this
 *    PR fixes) was feeding already-expired/recoverable coins into `renewVtxos`; the
 *    recover-first drain in `renewExpiringVtxos` now prevents that, but the operator can
 *    still reject a stale/raced intent, and the failed-settle `deleteIntent` cleanup can
 *    itself fail ("intent may linger… 'duplicated input' on next settle"). We surface a
 *    clear, retryable message instead of the raw code.
 *  • `duplicated input` — a lingering intent from a prior failed settle is still
 *    registered, wedging the next one. Same treatment: tell the user to retry shortly.
 *
 * Returns a user-facing `Error` for those cases, or `null` to signal "not one of these,
 * rethrow as-is". Never throws.
 */
export function translateSettleError(err: unknown): Error | null {
  if (!(err instanceof Error)) return null;
  const msg = err.message;
  if (/INVALID_INTENT_PROOF|no matching intents found/i.test(msg)) {
    return new Error(
      'The renewal round was rejected by the operator (no matching intent). ' +
        'Your funds are safe — please try again in a moment.',
    );
  }
  if (/duplicated input/i.test(msg)) {
    return new Error(
      'A previous renewal attempt is still settling. Your funds are safe — ' +
        'please wait a moment and try again.',
    );
  }
  return null;
}

/**
 * Select the VTXOs that are genuinely RENEWABLE: expiring within `marginMs` of their
 * batch expiry AND still valid (not yet expired, not swept, still spendable).
 *
 * Used as the GATE for {@link renewExpiringVtxos} — if nothing is renewable we skip the
 * renew round entirely. Note it does NOT constrain `renewVtxos`'s inputs (that method
 * re-derives its own broad set and accepts no input list); the actual protection
 * against feeding expired/swept coins into renew is the recover-first drain inside
 * {@link renewExpiringVtxos}. This predicate only answers "is there anything worth
 * renewing at all?".
 */
export function selectRenewable(
  vtxos: ExtendedVirtualCoin[],
  marginMs: number,
): ExtendedVirtualCoin[] {
  return vtxos.filter(
    (v) =>
      isSpendable(v) &&
      !isExpired(v) &&
      !isRecoverable(v) &&
      isVtxoExpiringSoon(v, marginMs),
  );
}

/**
 * Deliberately renew VTXOs that fall within `marginMs` of their batch expiry but are
 * STILL VALID (not expired, not swept).
 *
 * With `settlementConfig:false` the wallet does NO background renewal (Track E made the
 * SW wallet never sign unprompted). This is the explicit fallback: build the SDK's
 * `VtxoManager` and call `renewVtxos({ thresholdSeconds })` — the manager settles the
 * expiring coins into a fresh batch with a reset expiry, returning a commitment txid.
 * We MUST pass an explicit threshold: with `settlementConfig:false`, the manager's
 * default short-circuits to a 3-day window unless told otherwise.
 *
 * Selection is GUARDED here (not delegated to the SDK's broad `getExpiringVtxos`): only
 * expiring-still-valid coins ever reach `renewVtxos`. Already-expired/recoverable coins
 * are excluded — they go through `recoverExpiredVtxos`.
 *
 * The caller guarantees the wallet is unlocked (this signs). "No VTXOs available to
 * renew" from the SDK is a no-op, not an error — return `{ renewed: 0 }`.
 */
export async function renewExpiringVtxos(
  wallet: Wallet,
  marginMs: number,
): Promise<{ renewed: number; txid?: string }> {
  const vtxos = await wallet.getVtxos({ withRecoverable: true });
  const renewable = selectRenewable(vtxos, marginMs);
  // Nothing renewable → no-op. Critically, we never call renewVtxos when only expired/
  // recoverable coins exist: that is exactly what triggered INVALID_INTENT_PROOF.
  if (renewable.length === 0) return { renewed: 0 };

  const manager = await wallet.getVtxoManager();
  const thresholdSeconds = Math.max(1, Math.round(marginMs / 1000));
  try {
    // PROTOCOL-CRITICAL ORDERING. The SDK's `renewVtxos` does NOT accept an input list:
    // it re-derives its own set via `getExpiringAndRecoverableVtxos`, which is
    // `isVtxoExpiringSoon || isRecoverable || (isSpendable && isExpired) || isSubdust`.
    // So if any swept (`isRecoverable`) or already-expired (`isSpendable && isExpired`)
    // coin coexists with a genuinely expiring-soon one, `renewVtxos` would settle the
    // swept/expired coin too — the operator then rejects the round with
    // `INVALID_INTENT_PROOF (23): no matching intents found` (the reproduced bug).
    //
    // We cannot filter renew's inputs, so we DRAIN the poisoning coins first:
    // `recoverVtxos` settles exactly `isRecoverable || (isSpendable && isExpired) ||
    // preconfirmed-subdust` back into fresh settled VTXOs. After it completes, none of
    // those coins match `getExpiringAndRecoverableVtxos` any more, so the subsequent
    // `renewVtxos` sees a CLEAN set of only expiring-soon-still-valid coins.
    //
    // Residual TOCTOU (documented, non-fatal): `renewVtxos` internally re-fetches and
    // `revalidateBeforeSettle`s right before settling, so a coin the operator sweeps in
    // the sub-second window between our recover call and that revalidation could re-enter
    // the set and re-trigger `INVALID_INTENT_PROOF`. That deterministic case (an
    // already-expired coin sitting there) is eliminated by recover-first; the remaining
    // race is rare and SELF-HEALING — the catch below maps it to a retryable message
    // (manual path) and the scheduler swallows + retries it next tick (recovering the
    // newly-swept coin first), so no funds are stuck and no intent stays wedged.
    if (hasRecoverableOrExpired(vtxos)) {
      try {
        await manager.recoverVtxos();
      } catch (err) {
        // "No recoverable" means nothing to drain (race) — fine, proceed to renew.
        if (!(err instanceof Error && /no recoverable/i.test(err.message))) {
          const human = translateSettleError(err);
          throw human ?? err;
        }
      }
    }

    const txid = await manager.renewVtxos(undefined, { thresholdSeconds });
    return { renewed: renewable.length, txid };
  } catch (err) {
    // Race: a coin stopped being renewable between the check and the call.
    if (err instanceof Error && /no vtxos available to renew/i.test(err.message)) {
      return { renewed: 0 };
    }
    // Lingering-intent / INVALID_INTENT_PROOF → human, non-fatal message (don't wedge).
    const human = translateSettleError(err);
    if (human) throw human;
    throw err;
  } finally {
    await manager.dispose();
  }
}

/**
 * True when any VTXO is swept/recoverable or already-expired-but-spendable — the coins
 * that POISON a renew round (renew settling them yields `INVALID_INTENT_PROOF`). Gates
 * the recover-first drain in {@link renewExpiringVtxos}.
 *
 * Deliberately NARROWER than the SDK's full recovery set (`getRecoverableVtxos`, which
 * also includes `state==='preconfirmed' && isSubdust`): a preconfirmed-subdust coin is
 * neither swept nor expired, so it carries a valid registered intent and settles fine
 * inside renew's own `isSubdust` clause — it does not poison the round. Including it
 * here would spin up needless recover rounds for benign dust, so we leave it for renew
 * to absorb.
 */
export function hasRecoverableOrExpired(vtxos: ExtendedVirtualCoin[]): boolean {
  return vtxos.some((v) => isRecoverable(v) || (isSpendable(v) && isExpired(v)));
}

/**
 * Recover already-expired / swept VTXOs by re-settling them back to the wallet's own
 * Arkade address — the operator re-issues them in a fresh batch. This is the DISTINCT
 * lifecycle from renewal: renewal refreshes still-valid coins approaching expiry;
 * recovery reclaims coins whose batch expiry has ALREADY passed (swept by the operator,
 * `state === "swept"`, OR time-expired-but-not-yet-swept). Renewal cannot touch these —
 * feeding them to `renewVtxos` is the reproduced `INVALID_INTENT_PROOF` bug.
 *
 * Uses the SDK's `VtxoManager.recoverVtxos()`, whose selection (`getRecoverableVtxos`)
 * is `isRecoverable || (isSpendable && isExpired) || preconfirmed-subdust` — so it
 * covers BOTH the swept and the time-expired-unswept buckets, plus economically-viable
 * subdust. Settles them home and returns a commitment txid. No-op when nothing is
 * recoverable.
 *
 * The caller guarantees the wallet is unlocked (this signs).
 */
export async function recoverExpiredVtxos(
  wallet: Wallet,
): Promise<{ recovered: number; sats: number; txid?: string }> {
  const manager = await wallet.getVtxoManager();
  try {
    // Cheap, no-signing probe first — avoids spinning up a batch round for nothing.
    const recoverable = await manager.getRecoverableBalance();
    if (recoverable.vtxoCount === 0 || recoverable.recoverable <= 0n) {
      return { recovered: 0, sats: 0 };
    }
    const txid = await manager.recoverVtxos();
    return {
      recovered: recoverable.vtxoCount,
      sats: Number(recoverable.recoverable),
      txid,
    };
  } catch (err) {
    // Best-effort no-op cases: nothing recoverable, or the capped batch fell below dust
    // (the recoverable set existed but couldn't form an economical output) — neither is
    // a user-facing failure.
    if (
      err instanceof Error &&
      /no recoverable|below the dust threshold/i.test(err.message)
    ) {
      return { recovered: 0, sats: 0 };
    }
    const human = translateSettleError(err);
    if (human) throw human;
    throw err;
  } finally {
    await manager.dispose();
  }
}

/**
 * Deliberately onboard confirmed boarding UTXOs into VTXOs (Track F).
 *
 * `settlementConfig:false` also killed the silent boarding sweep, so on-chain
 * deposits no longer auto-onboard. This is the explicit, unlock-gated path: fetch the
 * operator's fee schedule and run `Ramps.onboard(fees)`, which settles all boarding
 * inputs into VTXOs via a batch swap (returns a commitment txid). No-op when there's
 * nothing confirmed to onboard.
 *
 * `Ramps.onboard` is a batch settle like any other, so the same opaque intent errors
 * can surface — translate them to a human, non-fatal message rather than leaking the
 * raw protocol text (parity with the send path).
 *
 * The caller guarantees the wallet is unlocked (this signs).
 */
export async function onboardBoarding(
  wallet: Wallet,
): Promise<{ onboarded: boolean; txid?: string }> {
  const balance = await wallet.getBalance();
  if (balance.boarding.confirmed <= 0) return { onboarded: false };
  const info = await wallet.arkProvider.getInfo();
  try {
    const txid = await new Ramps(wallet).onboard(info.fees);
    return { onboarded: true, txid };
  } catch (err) {
    const human = translateSettleError(err);
    if (human) throw human;
    throw err;
  }
}

/**
 * Count both the time-expired-but-unswept (needs-renewal) and swept-recoverable
 * (needs-recovery) buckets plus the soonest upcoming expiry — used by the renewal
 * scheduler to refresh the warning snapshot the popup reads. Lighter than recomputing
 * the full balance.
 */
export async function getExpiredVtxoSummary(wallet: Wallet): Promise<{
  expiredSats: number;
  count: number;
  recoverableSats: number;
  recoverableCount: number;
  nextExpiryAtMs: number | null;
}> {
  const vtxos = await wallet.getVtxos({ withRecoverable: true });
  const { spendable, expired, expiredSats, recoverable, recoverableSats } =
    partitionVtxos(vtxos);
  return {
    expiredSats,
    count: expired.length,
    recoverableSats,
    recoverableCount: recoverable.length,
    nextExpiryAtMs: soonestExpiry(spendable),
  };
}
