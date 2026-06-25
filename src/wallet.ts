import {
  Wallet,
  SeedIdentity,
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
    // ponytail: read-only scope — no settlementConfig/delegateProvider here (Track F).
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
