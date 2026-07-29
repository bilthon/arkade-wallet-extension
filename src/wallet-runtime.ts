import { SeedIdentity, type NetworkName, type Wallet } from '@arkade-os/sdk';
import { mnemonicToSeed } from './crypto';
import { buildWallet, networkConfig } from './wallet';
import { withTimeout } from './async';

/**
 * The service worker's live wallet session.
 *
 * Durable encrypted key material belongs to the keystore and storage modules. Once a
 * password has opened that vault, this module becomes the sole authority for the live
 * signing identity, its network, and the lazily constructed SDK wallet. Neither the
 * mnemonic nor an application-owned raw seed is retained here.
 */

interface RuntimeSession {
  epoch: number;
  network: NetworkName;
  identity: SeedIdentity;
  wallet: Wallet | null;
  pendingWallet: Promise<Wallet> | null;
  lastRefreshMs: number;
  refreshPromise: Promise<void> | null;
}

let session: RuntimeSession | null = null;
let epoch = 0;

/** Bounds a single wallet build so a hung operator `getInfo` cannot wedge later callers. */
const BUILD_TIMEOUT_MS = 8_000;

/** Bounds a single refresh so a hung indexer cannot wedge later callers. */
const REFRESH_TIMEOUT_MS = 60_000;

export function isUnlocked(): boolean {
  return session !== null;
}

/** The network bound to the current live identity. */
export function getSessionNetwork(): NetworkName {
  if (!session) throw new Error('LOCKED');
  return session.network;
}

/**
 * Install a new live identity without contacting the operator. The temporary raw seed is
 * cleared immediately after `SeedIdentity` copies it. Wallet construction remains lazy,
 * so a correct password unlocks even while the operator is offline.
 *
 * Session replacement is synchronous. The returned promise only represents best-effort
 * disposal of the previous resolved wallet.
 */
export function openSession(mnemonic: string, network: NetworkName): Promise<void> {
  const identity = identityFromMnemonic(mnemonic, network);
  const previous = session;
  session = createSession(identity, network);
  return disposeRuntimeSession(previous);
}

function identityFromMnemonic(mnemonic: string, network: NetworkName): SeedIdentity {
  const seed = mnemonicToSeed(mnemonic);
  try {
    return SeedIdentity.fromSeed(seed, { isMainnet: networkConfig(network).isMainnet });
  } finally {
    seed.fill(0);
  }
}

function createSession(identity: SeedIdentity, network: NetworkName): RuntimeSession {
  return {
    epoch: ++epoch,
    network,
    identity,
    wallet: null,
    pendingWallet: null,
    lastRefreshMs: 0,
    refreshPromise: null,
  };
}

/**
 * Revoke the live session synchronously, then return its asynchronous cleanup. A caller
 * cannot acquire the old identity or wallet after this function returns.
 */
export function beginSessionLock(): { didLock: boolean; disposal: Promise<void> } {
  const previous = session;
  if (!previous) return { didLock: false, disposal: Promise.resolve() };

  session = null;
  epoch++;
  return { didLock: true, disposal: disposeRuntimeSession(previous) };
}

/**
 * Get the session wallet, building it once if needed. This function deliberately stays
 * non-async: the pending promise is installed before any caller can reach an `await`, so
 * concurrent requests always share one build.
 */
export function getSessionWallet(): Promise<Wallet> {
  const owner = session;
  if (!owner) return Promise.reject(new Error('LOCKED'));
  if (owner.wallet) return Promise.resolve(owner.wallet);
  if (owner.pendingWallet) return owner.pendingWallet;

  const mine = buildSessionWallet(owner);
  owner.pendingWallet = mine;
  const clear = () => {
    if (owner.pendingWallet === mine) owner.pendingWallet = null;
  };
  mine.then(clear, clear);
  return mine;
}

/** Build a fresh wallet for one captured runtime session and cache it only if still current. */
async function buildSessionWallet(owner: RuntimeSession): Promise<Wallet> {
  const build = buildWallet(owner.identity, owner.network);

  // `withTimeout` races rather than cancels. If the timer wins, dispose the wallet when
  // the underlying build eventually resolves so it cannot leak managers or watchers.
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

  if (session !== owner) {
    await disposeWallet(wallet);
    throw new Error('LOCKED');
  }

  owner.wallet = wallet;
  return wallet;
}

/**
 * Invalidate the SDK wallet while retaining the live identity and network. This temporary
 * API preserves the current network-switch choreography; the serialized switch transition
 * will replace it with an explicit session fence later in this refactor.
 */
export function invalidateSessionWallet(): Promise<void> {
  const previous = session;
  if (!previous) return Promise.resolve();

  session = createSession(previous.identity, previous.network);
  return disposeRuntimeSession(previous);
}

async function disposeRuntimeSession(owner: RuntimeSession | null): Promise<void> {
  if (!owner) return;

  const wallet = owner.wallet;
  owner.wallet = null;
  owner.pendingWallet = null;
  owner.lastRefreshMs = 0;
  owner.refreshPromise = null;
  if (wallet) await disposeWallet(wallet);
}

/**
 * Dispose a wallet and permanently disable both manager accessors. SDK `dispose()` stops
 * existing managers but otherwise leaves these accessors able to recreate background work.
 */
async function disposeWallet(wallet: Wallet): Promise<void> {
  wallet.getContractManager = () => Promise.reject(new Error('LOCKED'));
  wallet.getVtxoManager = () => Promise.reject(new Error('LOCKED'));
  await wallet.dispose().catch(() => {});
}

/**
 * Reconcile the current wallet's VTXO cache, unless it was refreshed within `maxAgeMs`.
 * Freshness and the in-flight refresh promise belong to one RuntimeSession, so neither can
 * leak into a later unlock or network.
 */
export async function ensureFreshVtxos(wallet: Wallet, maxAgeMs = 10_000): Promise<void> {
  const owner = session;
  if (!owner || owner.wallet !== wallet) throw new Error('LOCKED');
  if (owner.refreshPromise) return owner.refreshPromise;
  if (Date.now() - owner.lastRefreshMs < maxAgeMs) return;

  const mine = withTimeout(refreshVtxosNow(wallet), REFRESH_TIMEOUT_MS, 'vtxo refresh');
  owner.refreshPromise = mine;
  try {
    await mine;
    // The uncancellable inner refresh may finish after a timeout or invalidation. Stamp
    // freshness only when this exact session and wallet still own the successful result.
    if (session === owner && owner.wallet === wallet) owner.lastRefreshMs = Date.now();
  } finally {
    if (owner.refreshPromise === mine) owner.refreshPromise = null;
  }
}

async function refreshVtxosNow(wallet: Wallet): Promise<void> {
  const manager = await wallet.getContractManager();
  await manager.refreshVtxos();
}
