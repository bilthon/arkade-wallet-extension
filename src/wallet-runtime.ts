import type { NetworkName, Wallet } from '@arkade-os/sdk';
import { getUnlockedSeed, isUnlocked } from './keystore';
import { getNetwork as getStoredNetwork } from './storage';
import { buildWallet } from './wallet';
import { withTimeout } from './async';

/**
 * Session-scoped Arkade wallet.
 *
 * Before this module existed, every background message built its own `Wallet` via
 * `buildWallet(seed)`. That meant a fresh `ContractManager`, a fresh `ContractWatcher`,
 * and a fresh SDK transaction lock per message, all torn down again right after.
 * This module instead holds one `Wallet` for as long as the service worker stays
 * unlocked on one network, and every read/send/renewal path shares it.
 *
 * Construction is also how the SDK refreshes its VTXO cache: `Wallet.create` runs
 * the contract manager's `initialize()`, which reconciles watched contracts against
 * the operator. Removing per-message construction removes that implicit sync too,
 * so a read that needs a live view must call `ensureFreshVtxos` first.
 */

// ─── Session wallet ────────────────────────────────────────────────────────────

let resolvedWallet: Wallet | null = null;
let resolvedNetwork: NetworkName | null = null;
let pendingWallet: Promise<Wallet> | null = null;
// Bumped by invalidateSessionWallet. Lets a build already in flight when a lock or
// network switch happens detect, once it resolves, that it landed too late and
// self-destruct instead of leaking a live ContractWatcher past the seed or network
// it was built from. See buildSessionWallet's post-build check.
let generation = 0;

/** Bounds a single wallet build so a hung operator `getInfo` can't wedge every later caller. */
const BUILD_TIMEOUT_MS = 8_000;

/**
 * Get the session's `Wallet`, building it if needed. Reads the unlocked seed and
 * the active network itself on every call, so no caller can hand it a stale pair
 * and the lock guard lives in one place instead of being re-implemented at every
 * call site.
 *
 * Deliberately neutral about auto-lock: it does not check, extend, or otherwise
 * change the auto-lock deadline. The caller decides whether an access counts as
 * user activity.
 */
export function getSessionWallet(): Promise<Wallet> {
  if (pendingWallet) return pendingWallet;
  const mine = resolveSessionWallet();
  pendingWallet = mine;
  // Clear the memo on EITHER outcome so the next call re-derives the network and
  // re-checks the cache, rather than a rejection permanently poisoning it. Using
  // `.then` with both handlers (not `.finally`) keeps this cleanup promise itself
  // from rejecting, since `mine` is already returned to and handled by the caller.
  const clear = () => {
    if (pendingWallet === mine) pendingWallet = null;
  };
  mine.then(clear, clear);
  return mine;
}

/**
 * The actual per-call logic behind `getSessionWallet`. Split out so the
 * memoization above stays synchronous: two concurrent `getSessionWallet()` calls
 * both see `pendingWallet` already set before either reaches an `await`, so they
 * share this one promise instead of each starting a build.
 */
async function resolveSessionWallet(): Promise<Wallet> {
  const network = await getStoredNetwork();

  if (resolvedNetwork !== null && resolvedNetwork !== network) {
    // The active network moved since the last build. The cached wallet points at
    // the wrong operator now, so drop it before building fresh.
    await invalidateSessionWallet();
  }

  if (resolvedWallet && resolvedNetwork === network) return resolvedWallet;

  return buildSessionWallet(network);
}

/** Build a fresh session wallet for `network` and cache it on success. */
async function buildSessionWallet(network: NetworkName): Promise<Wallet> {
  const seed = getUnlockedSeed();
  if (!seed || !isUnlocked()) throw new Error('LOCKED');

  const gen = generation;
  const wallet = await withTimeout(buildWallet(seed, network), BUILD_TIMEOUT_MS, 'wallet build');

  // A lock or a network switch landing during the build above invalidates it: the
  // generation moved, or the unlocked seed is no longer the one we started with.
  // Either way this wallet must not become the cached one.
  if (gen !== generation || getUnlockedSeed() !== seed) {
    await wallet.dispose().catch(() => {});
    throw new Error('LOCKED');
  }

  resolvedWallet = wallet;
  resolvedNetwork = network;
  return wallet;
}

/**
 * Drop the session wallet: bump the generation, clear every cached reference, and
 * dispose the old wallet. Called on lock and on a real network switch.
 *
 * The generation bump and reference clearing happen synchronously, before the
 * `await` on disposal, so a build already in flight can detect (once it resolves)
 * that it is now stale and self-destruct instead of getting cached — see
 * `buildSessionWallet`'s post-build check. Disposal itself is best-effort: a
 * failure here must not block locking or switching networks.
 */
export async function invalidateSessionWallet(): Promise<void> {
  generation++;
  const wallet = resolvedWallet;
  resolvedWallet = null;
  resolvedNetwork = null;
  // The freshness window belongs to the wallet we just dropped; a wallet built
  // next (possibly for a different network) starts with no assumed freshness.
  lastRefreshMs = 0;
  refreshPromise = null;
  if (wallet) await wallet.dispose().catch(() => {});
}

// ─── VTXO freshness ────────────────────────────────────────────────────────────

let lastRefreshMs = 0;
let refreshPromise: Promise<void> | null = null;

/** Bounds a single refresh so a hung indexer can't wedge every later caller. */
const REFRESH_TIMEOUT_MS = 60_000;

/**
 * Reconcile the wallet's VTXO cache against the operator, unless a refresh
 * already finished within `maxAgeMs`. Construction used to do this implicitly on
 * every message; with one shared wallet it has to be explicit before any read
 * that needs a live view: `listCoins`, coin selection in a send, the renewal
 * tick's `selectRenewable`, and the balance snapshot.
 *
 * Memoizes the in-flight refresh so concurrent callers join one reconciliation
 * instead of each starting their own.
 */
export async function ensureFreshVtxos(wallet: Wallet, maxAgeMs = 10_000): Promise<void> {
  if (refreshPromise) return refreshPromise;
  if (Date.now() - lastRefreshMs < maxAgeMs) return;

  const mine = refreshVtxosNow(wallet);
  refreshPromise = mine;
  try {
    await mine;
  } finally {
    if (refreshPromise === mine) refreshPromise = null;
  }
}

async function refreshVtxosNow(wallet: Wallet): Promise<void> {
  const manager = await wallet.getContractManager();
  await withTimeout(manager.refreshVtxos(), REFRESH_TIMEOUT_MS, 'vtxo refresh');
  lastRefreshMs = Date.now();
}
