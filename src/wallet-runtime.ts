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
 * Per-message construction was also what kept the VTXO cache fresh, though not via
 * `Wallet.create` itself. The contract manager is built lazily on the first
 * `getContractManager()`, and building it reconciles the watched contracts against
 * the operator. Every read went through `wallet.getVtxos()`, which calls
 * `getContractManager()`, so each message paid one delta sync. One shared wallet
 * builds that manager once, so a read that needs a live view now has to call
 * `ensureFreshVtxos` first.
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
  // Check the lock before the cache read, not just on the build path below. `lock()`
  // zeroes the seed and then awaits two storage writes before its listeners run
  // `invalidateSessionWallet`, so for that window the wallet is already locked while
  // the cached one is still here. Handing it out would let a post-lock caller sign,
  // because the SDK identity was derived at build time and never re-reads the seed.
  if (!getUnlockedSeed() || !isUnlocked()) throw new Error('LOCKED');

  const network = await getStoredNetwork();

  if (resolvedNetwork !== null && resolvedNetwork !== network) {
    // The active network moved since the last build. The cached wallet points at
    // the wrong operator now, so drop it before building fresh.
    //
    // Unreachable today, and deliberately so: the only writer of the stored network
    // is the switchNetwork handler, which invalidates both this runtime and the
    // Lightning one on either side of the write. This branch would invalidate the
    // wallet WITHOUT disposing the Lightning runtime, which breaks the rule that the
    // two are always torn down together. Kept as a backstop, but any future caller
    // that can reach it has to dispose the Lightning runtime too.
    await invalidateSessionWallet();
  }

  if (resolvedWallet && resolvedNetwork === network) return resolvedWallet;

  return buildSessionWallet(network);
}

/**
 * Dispose a wallet we are finished with, and make sure it stays dead.
 *
 * `Wallet.dispose()` clears both of the wallet's managers but leaves the wallet
 * usable, and each accessor rebuilds when it finds its field empty. That matters
 * because handlers hold their wallet across awaits, so a read racing a lock resumes
 * after we disposed and rebuilds whatever it asks for, on a wallet nobody holds a
 * reference to any more:
 *  1. `getContractManager()` starts a fresh ContractWatcher with its own subscription
 *     and its own repeating poll, which nothing can then stop.
 *  2. `getVtxoManager()` constructs a VtxoManager, whose constructor schedules a
 *     self-rescheduling boarding poll that auto-settles. That poll is inert only
 *     because we pass `settlementConfig: false`. Automatic boarding is the planned
 *     follow-up to this refactor, and it would turn this into a leaked poll that
 *     signs on its own.
 *
 * Replacing both accessors closes the hole. Reads that belong to a dead session now
 * fail with LOCKED, which the messaging layer already routes to the unlock screen,
 * instead of leaking background work for the rest of the service worker's life. We
 * swap them before disposing so there is no window where the old ones still work.
 * Disposal itself is unaffected: it reads the manager fields directly, never through
 * these accessors.
 */
async function disposeWallet(wallet: Wallet): Promise<void> {
  wallet.getContractManager = () => Promise.reject(new Error('LOCKED'));
  wallet.getVtxoManager = () => Promise.reject(new Error('LOCKED'));
  await wallet.dispose().catch(() => {});
}

/** Build a fresh session wallet for `network` and cache it on success. */
async function buildSessionWallet(network: NetworkName): Promise<Wallet> {
  const seed = getUnlockedSeed();
  if (!seed || !isUnlocked()) throw new Error('LOCKED');

  const gen = generation;
  const build = buildWallet(seed, network);
  // `withTimeout` races, it does not cancel. When the timer wins, the build keeps
  // running and resolves into a live wallet nobody holds a reference to. Dispose that
  // one, or a slow operator leaks a watcher per timed-out attempt, which is the
  // pile-up this module exists to remove.
  let timedOut = false;
  build.then(
    (late) => {
      if (timedOut) void disposeWallet(late);
    },
    () => {},
  );

  let wallet: Wallet;
  try {
    wallet = await withTimeout(build, BUILD_TIMEOUT_MS, 'wallet build');
  } catch (err) {
    timedOut = true;
    throw err;
  }

  // A lock or a network switch landing during the build above invalidates it: the
  // generation moved, or the unlocked seed is no longer the one we started with.
  // Either way this wallet must not become the cached one.
  if (gen !== generation || getUnlockedSeed() !== seed) {
    await disposeWallet(wallet);
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
  if (wallet) await disposeWallet(wallet);
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

  // The bound covers the whole refresh, not just `refreshVtxos()`. The first
  // `getContractManager()` of a session is itself an indexer round trip, and the SDK's
  // REST provider passes no abort signal, so a black-holed request there never settles.
  // Timing out only the second half would leave this memo set forever and every later
  // caller would join a promise that never resolves.
  const mine = withTimeout(refreshVtxosNow(wallet), REFRESH_TIMEOUT_MS, 'vtxo refresh');
  refreshPromise = mine;
  try {
    await mine;
  } finally {
    if (refreshPromise === mine) refreshPromise = null;
  }
}

async function refreshVtxosNow(wallet: Wallet): Promise<void> {
  const gen = generation;
  const manager = await wallet.getContractManager();
  await manager.refreshVtxos();
  // Only stamp the freshness window if this refresh still belongs to the current
  // wallet. A refresh that lands after a lock or a network switch reconciled the OLD
  // wallet, so recording it would make the next wallet look fresh when nothing has
  // reconciled it, and reads would trust an unsynced cache for the whole window.
  if (gen === generation) lastRefreshMs = Date.now();
}
