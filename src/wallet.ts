import {
  Wallet,
  SeedIdentity,
  ArkAddress,
  networks,
  IndexedDBWalletRepository,
  IndexedDBContractRepository,
  type NetworkName,
  type WalletBalance,
} from '@arkade-os/sdk';
import { getNetwork as getStoredNetwork } from './storage';

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

/** Full balance breakdown (available/preconfirmed/settled/boarding/…) — NOT one number (PLAN.md §6). */
export function getBalance(wallet: Wallet): Promise<WalletBalance> {
  return wallet.getBalance();
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

// ─── Off-chain send: validation + sendBitcoin (Track E) ──────────────────────

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
 * `wallet.sendBitcoin({ address, amount })` — instant, ~zero fee, no L1 footprint
 * (PLAN.md §6 regime 1). Returns the txid the SDK gives.
 *
 * On-chain (`bc1…`) and Lightning are deliberately NOT routed here — they map to
 * `Ramps.offboard` / Boltz with their own approval UX (separate, later PRs).
 */
export async function sendBitcoin(
  wallet: Wallet,
  { address, amount }: { address: string; amount: number },
): Promise<{ txid: string }> {
  const network = await getStoredNetwork();
  validateArkadeAddress(address, network);

  // Validate the amount against the LIVE available balance (not a cached snapshot)
  // so a stale UI can't authorize an over-spend.
  const balance = await wallet.getBalance();
  validateAmount(amount, balance.available);

  const txid = await wallet.sendBitcoin({ address: address.trim(), amount });
  return { txid };
}
