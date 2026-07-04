import {
  Wallet,
  SeedIdentity,
  ArkAddress,
  Ramps,
  DustChangeError,
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
  type ArkTransaction,
} from '@arkade-os/sdk';
import { getNetwork as getStoredNetwork } from './storage';
import {
  adjustBalanceForExpiry,
  partitionVtxos,
  soonestExpiry,
  type AdjustedBalance,
} from './vtxo-state';

/**
 * SDK wallet runtime.
 *
 * The MV3 background SW is a STATELESS router: it holds no live `Wallet` between
 * wakes. `buildWallet(seed)` re-creates one on each wake from the in-memory seed
 * (held only in `keystore.ts`) + the IndexedDB repositories (where the SDK has
 * already persisted VTXO/balance/history state). Construction is therefore cheap —
 * the durable state lives in IndexedDB and survives SW restarts.
 *
 * Read-only scope only: addresses, balances, pubkey, network. NO send/sign/settle/
 * delegation here — those come later.
 */

// ─── Network → operator/esplora config ──────────────────────────

export interface NetworkConfig {
  /** Arkade operator (arkd) REST base. */
  arkServerUrl: string;
  /** Esplora REST base for on-chain (boarding) UTXO lookups. */
  esploraUrl: string;
  /** BIP86 coin type: mainnet (0') vs everything else (1'). Drives derivation. */
  isMainnet: boolean;
  /** Boltz swap API for this network; absent → Lightning UI hidden. */
  boltzApiUrl?: string;
}

/**
 * Endpoints per network. Switched together — operator + esplora (+ Boltz where available).
 * Delegate URLs are intentionally absent here; this is read-only.
 *
 * ponytail: regtest points at nigiri's local services. arkd on :7070, electrs REST
 * on :30000 — verified reachable from the SW (NOT chopsticks :3000, which is not the REST base).
 */
export const NETWORK_CONFIG: Record<NetworkName, NetworkConfig> = {
  regtest: {
    arkServerUrl: 'http://localhost:7070',
    esploraUrl: 'http://localhost:30000',
    isMainnet: false,
    boltzApiUrl: 'http://localhost:9069',
  },
  mutinynet: {
    arkServerUrl: 'https://mutinynet.arkade.sh',
    esploraUrl: 'https://mutinynet.com/api',
    isMainnet: false,
    boltzApiUrl: 'https://api.boltz.mutinynet.arkade.sh',
  },
  signet: {
    arkServerUrl: 'https://signet.arkade.sh',
    esploraUrl: 'https://mempool.space/signet/api',
    isMainnet: false,
    boltzApiUrl: 'https://api.boltz.signet.arkade.sh',
  },
  testnet: {
    arkServerUrl: 'https://testnet.arkade.sh',
    esploraUrl: 'https://mempool.space/testnet/api',
    isMainnet: false,
    // No known Boltz deployment for this network — Lightning tab stays hidden.
  },
  bitcoin: {
    arkServerUrl: 'https://arkade.computer',
    esploraUrl: 'https://mempool.space/api',
    isMainnet: true,
    boltzApiUrl: 'https://api.ark.boltz.exchange',
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
    // they still resolve to Rest/Esplora providers under the hood. Keep the URL
    // form until we need provider injection.
    arkServerUrl: cfg.arkServerUrl,
    esploraUrl: cfg.esploraUrl,
    // IndexedDB repos = the durability mechanism (survives SW restarts). Omitting
    // storage would default to in-memory and lose all state on every SW kill.
    storage: {
      // Per-network DB names keep each network's VTXO cache isolated across switches.
      // This orphans the previous default-named DB — a harmless one-time re-sync on
      // existing wallets (the SDK rebuilds the cache from the operator on the next read).
      walletRepository: new IndexedDBWalletRepository(`arkade-wallet-${network}`),
      contractRepository: new IndexedDBContractRepository(`arkade-contract-${network}`),
    },
    // settlementConfig: false makes the wallet DELIBERATE — no background signing.
    //
    // With neither settlementConfig nor renewalConfig, the SDK falls back to
    // DEFAULT_SETTLEMENT_CONFIG (boardingUtxoSweep + 60s poll) and `Wallet.create`
    // eagerly starts a VtxoManager poll that auto-settles (onboards) new boarding
    // UTXOs into VTXOs and auto-renews on `vtxo_received` — all with NO user action.
    // That is why the read-only wallet silently onboarded funds. A per-wake
    // stateless SW wallet must not sign in the background, and explicit sends
    // must be the only signing path. Deliberate renewal/delegation is a later
    // job and will opt back in via `delegateProvider` / an explicit settlementConfig.
    settlementConfig: false,
  });
}

// ─── Read methods (operate on a built wallet) ────────────────────────────────

/** Operator-bound Arkade address (`ark`/`tark…`) — NOT a plain BIP86 P2TR. */
export function getAddress(wallet: Wallet): Promise<string> {
  return wallet.getAddress();
}

/** On-chain boarding address — receives normal UTXOs, later onboarded to VTXOs. */
export function getBoardingAddress(wallet: Wallet): Promise<string> {
  return wallet.getBoardingAddress();
}

/**
 * Full balance breakdown, corrected for expired-but-unswept VTXOs.
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
 * a different Arkade address (operator is baked into the address).
 * ponytail: no interactive picker UI yet (read-only pill); this exists for later
 * renewal and the settings screen to call, and for completeness of the wallet surface.
 */
export { setNetwork } from './storage';

/**
 * Raw user key as hex — x-only (32B) + compressed (33B). Exposed for web apps that
 * build their own VtxoScripts (escrow/HTLC); the operator-bound Arkade address
 * encodes a *tweaked* output key, not this raw key. No UI; just exposed.
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

// ─── Off-chain send: validation + send ──────────────────────

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
      | 'AMOUNT_EXCEEDS_BALANCE'
      | 'SETTLEMENT_WINDOW_NOT_OPEN',
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

  // 1) On-chain address → explicit, non-silent rejection (offboard is a separate,
  //    later flow; never silently route an Arkade send on-chain).
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
 * Validate that `address` is an on-chain Bitcoin address for the ACTIVE network.
 *
 * ponytail: prefix check only, consistent with `validateArkadeAddress`. The operator's
 * `Ramps.offboard` enforces full bech32 validity at the protocol level. We catch the
 * most common user error — pasting a mainnet address on regtest — with a clear
 * cross-network message rather than an opaque protocol reject.
 *
 * Throws `SendValidationError`; returns nothing on success.
 */
export function validateOnchainAddress(address: string, network: NetworkName): void {
  const trimmed = address.trim();
  if (!trimmed) {
    throw new SendValidationError('ADDRESS_MALFORMED', 'Enter a Bitcoin address.');
  }
  const onchainHrp = onchainPrefixFor(network);
  const lower = trimmed.toLowerCase();
  if (!lower.startsWith(`${onchainHrp}1`)) {
    // Cross-network on-chain address (e.g. bc1… on regtest) → precise message.
    const looksOnchain =
      lower.startsWith('bc1') || lower.startsWith('tb1') || lower.startsWith('bcrt1');
    if (looksOnchain) {
      throw new SendValidationError(
        'ADDRESS_WRONG_NETWORK',
        `That address is for a different network (expected a "${onchainHrp}1…" address).`,
      );
    }
    throw new SendValidationError(
      'ADDRESS_MALFORMED',
      'Enter a valid on-chain Bitcoin address (bc1… / tb1… / bcrt1…).',
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
 * `wallet.send({ address, amount })` — instant, ~zero fee, no L1 footprint.
 * Returns the txid the SDK gives.
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

/**
 * On-chain exit (offboard): collaboratively settle VTXOs to a regular Bitcoin address
 * via `Ramps.offboard`. Operator-cooperative batch settle — the same mechanism as
 * `onboardBoarding` / `Ramps.onboard`. NOT unilateral exit. Signs in the SW (caller
 * guarantees the wallet is unlocked).
 *
 * Fee semantics (from SDK d.ts): `feeInfo` is "deducted from the offboard amount" —
 * the amount is GROSS; the recipient receives (amount − network fee). When `amount` is
 * omitted, the SDK offboards ALL virtual outputs (send-all / "Max") and deducts the fee
 * from the total internally.
 */
export async function sendOnchain(
  wallet: Wallet,
  { address, amount }: { address: string; amount?: number },
): Promise<{ txid: string }> {
  const network = await getStoredNetwork();
  validateOnchainAddress(address, network);
  if (amount !== undefined) {
    const balance = await getBalance(wallet);
    validateAmount(amount, balance.available);
  }
  const info = await wallet.arkProvider.getInfo();

  // An offboard is a collaborative-exit `settle` that BLOCKS until the operator's next
  // settlement session runs. When the operator gates settlement to scheduled windows
  // (market hours, `scheduledSession` non-null), that wait can be far longer than the MV3
  // service worker survives (killed ~30s idle, ~5min max even while busy) — so a blind
  // `await` would never resolve and the withdrawal would hang. Refuse up front with the
  // ETA instead. Today both Arkade operators advertise `scheduledSession: null` (on-demand
  // ~60s sessions), so this never fires; it's a guard for market-hours operators.
  // ponytail: assumes `nextStartTime` is epoch SECONDS (matches `sessionDuration:"60"`s);
  // unverified against a live scheduled operator — revisit if an operator enables sessions.
  const sched = info.scheduledSession;
  if (sched) {
    const waitMs = Number(sched.nextStartTime) * 1000 - Date.now();
    if (waitMs > 90_000) {
      const mins = Math.ceil(waitMs / 60_000);
      throw new SendValidationError(
        'SETTLEMENT_WINDOW_NOT_OPEN',
        `On-chain withdrawals settle in scheduled windows. The next one opens in about ${mins} minute${mins === 1 ? '' : 's'} — keep the wallet open and withdraw then.`,
      );
    }
  }

  try {
    const txid = await new Ramps(wallet).offboard(
      address.trim(),
      info.fees,
      amount !== undefined ? BigInt(amount) : undefined,
    );
    return { txid };
  } catch (err) {
    // `Ramps.offboard` deducts a per-input fee from each VTXO BEFORE checking the amount,
    // so its real failures are fee-relative — none of them say "insufficient funds". Map
    // each to a clear, actionable message so a funds-leaving popup never shows raw SDK text.
    if (err instanceof DustChangeError) {
      throw new Error('The leftover change would be too small to keep. Use Max to withdraw everything.');
    }
    if (err instanceof Error && /no vtxos available after deducting fees/i.test(err.message)) {
      throw new Error('No spendable balance to withdraw on-chain right now.');
    }
    if (err instanceof Error && /greater than total amount of vtxos after fees/i.test(err.message)) {
      throw new Error(
        'That amount leaves too little after the network fee. Try a smaller amount, or use Max to withdraw everything.',
      );
    }
    const human = translateSettleError(err);
    if (human) throw human;
    throw err;
  }
}

// ─── Renewal + onboarding (deliberate, unlock-gated liveness) ───────

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
 * With `settlementConfig:false` the wallet does NO background renewal (the SW wallet
 * never signs unprompted). This is the explicit fallback: build the SDK's
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
 * Deliberately onboard confirmed boarding UTXOs into VTXOs.
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

// ─── Transaction history (Activity screen) ───────────────────────────────────

export interface TxHistoryItem {
  kind: 'deposit' | 'withdrawal' | 'sent' | 'received';
  incoming: boolean;   // true → +, false → −
  amount: number;      // sats, positive magnitude
  settled: boolean;
  createdAt: number;   // epoch ms
  txid: string;        // the primary relevant txid (for copy)
}

/**
 * Map an SDK `ArkTransaction` to the popup's display-ready `TxHistoryItem`.
 * Classifies the kind (deposit/withdrawal/sent/received) from the composite key
 * and derives the primary txid for the copy-to-clipboard affordance.
 *
 * NOTE: `tx.type` crosses the SW→popup JSON boundary as a plain string — compare
 * against the literal values 'SENT'/'RECEIVED', never the TxType enum at runtime.
 */
export function toHistoryItem(tx: ArkTransaction): TxHistoryItem {
  const { key, type, amount, settled, createdAt } = tx;
  const isReceived = type === 'RECEIVED';

  let kind: TxHistoryItem['kind'];
  let txid: string;

  if (isReceived && key.boardingTxid) {
    // On-chain deposit → boarding txid is the primary reference.
    kind = 'deposit';
    txid = key.boardingTxid;
  } else if (!isReceived && key.commitmentTxid && !key.arkTxid) {
    // Offboard (collaborative exit): commitment anchors the L1 settlement. A renew/settle
    // TO SELF never reaches here — the SDK only emits a SENT commitment record when
    // forfeitAmount > settledAmount (a real net outflow), so renew-to-self emits nothing.
    // Only edge: an exit netting to just the round fee shows as a tiny "Withdrawal".
    kind = 'withdrawal';
    txid = key.commitmentTxid;
  } else if (key.arkTxid) {
    // Off-chain Arkade send or receive.
    kind = isReceived ? 'received' : 'sent';
    txid = key.arkTxid;
  } else {
    // Fallback: classify by direction, pick the first non-empty txid.
    kind = isReceived ? 'received' : 'sent';
    txid = key.arkTxid || key.commitmentTxid || key.boardingTxid || '';
  }

  return { kind, incoming: isReceived, amount: Math.abs(amount), settled, createdAt, txid };
}

/** Fetch and normalise the wallet's full transaction history, newest first. */
export async function getTransactionHistory(wallet: Wallet): Promise<TxHistoryItem[]> {
  return (await wallet.getTransactionHistory()).map(toHistoryItem).sort((a, b) => b.createdAt - a.createdAt);
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
