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
  readonly epoch: number;
  readonly network: NetworkName;
  identity: SeedIdentity;
  wallet: Wallet | null;
  pendingWallet: Promise<Wallet> | null;
  lastRefreshMs: number;
  refreshPromise: Promise<void> | null;
}

export interface RuntimeVersion {
  readonly epoch: number;
  readonly network: NetworkName | null;
}

const PREPARED_NETWORK_SWITCH = Symbol('preparedNetworkSwitch');

interface PreparedSwitchState {
  source: RuntimeVersion;
  targetNetwork: NetworkName;
  identity: SeedIdentity | null;
  consumed: boolean;
}

interface ActiveNetworkTransition {
  fenceEpoch: number;
  hadSession: boolean;
  disposal: Promise<void>;
  cancel(): boolean;
}

/** Opaque staged identity tied to one exact source runtime version. */
export interface PreparedRuntimeNetworkSwitch {
  readonly [PREPARED_NETWORK_SWITCH]: PreparedSwitchState;
}

export interface RuntimeNetworkTransition {
  readonly hadSession: boolean;
  readonly disposal: Promise<void>;
  install(): boolean;
  abort(): void;
}

/**
 * An atomic capability for work performed by one live wallet session. Call
 * `assertCurrent()` immediately before any SDK operation that can sign or persist a
 * session-bound mutation; it rejects if a lock, unlock, or network transition replaced
 * the captured session while earlier asynchronous validation was running.
 */
export interface SessionContext {
  readonly wallet: Wallet;
  readonly network: NetworkName;
  readonly epoch: number;
  assertCurrent(): void;
}

let session: RuntimeSession | null = null;
let epoch = 0;
let activeNetworkTransition: ActiveNetworkTransition | null = null;

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

/** Capture runtime state without constructing the SDK wallet. */
export function getRuntimeVersion(): RuntimeVersion {
  return { epoch, network: session?.network ?? null };
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
  if (activeNetworkTransition) throw new Error('NETWORK_TRANSITION');
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

/**
 * Derive the target identity while the password-authenticated mnemonic is in scope. A
 * locked source deliberately stages no identity so a locked network switch stays locked.
 */
export function prepareRuntimeNetworkSwitch(
  mnemonic: string,
  targetNetwork: NetworkName,
  source: RuntimeVersion,
): PreparedRuntimeNetworkSwitch {
  if (activeNetworkTransition) throw new Error('STALE_NETWORK_SWITCH');
  assertRuntimeVersion(source);
  return {
    [PREPARED_NETWORK_SWITCH]: {
      source,
      targetNetwork,
      identity: source.network === null ? null : identityFromMnemonic(mnemonic, targetNetwork),
      consumed: false,
    },
  };
}

/**
 * Consume a prepared switch and synchronously fence its exact source session. Durable
 * storage is committed by the network-switch coordinator before `install()` is called.
 */
export function beginRuntimeNetworkSwitch(
  prepared: PreparedRuntimeNetworkSwitch,
): RuntimeNetworkTransition {
  const staged = prepared[PREPARED_NETWORK_SWITCH];
  if (staged.consumed) throw new Error('STALE_NETWORK_SWITCH');
  staged.consumed = true;
  try {
    assertRuntimeVersion(staged.source);
  } catch (err) {
    staged.identity = null;
    throw err;
  }

  const previous = session;
  session = null;
  const fenceEpoch = ++epoch;
  const disposal = disposeRuntimeSession(previous);
  let finished = false;
  let cancelled = false;
  const active = {
    fenceEpoch,
    hadSession: previous !== null,
    disposal,
    cancel() {
      staged.identity = null;
      if (cancelled) return false;
      cancelled = true;
      return previous !== null;
    },
  };
  activeNetworkTransition = active;

  return {
    hadSession: active.hadSession,
    disposal,
    install() {
      if (finished) throw new Error('STALE_NETWORK_SWITCH');
      finished = true;
      if (
        activeNetworkTransition !== active ||
        session !== null ||
        epoch !== active.fenceEpoch
      ) {
        staged.identity = null;
        throw new Error('LOCKED');
      }
      activeNetworkTransition = null;
      if (!staged.identity) return false;
      session = createSession(staged.identity, staged.targetNetwork);
      staged.identity = null;
      return true;
    },
    abort() {
      finished = true;
      staged.identity = null;
      if (activeNetworkTransition === active) activeNetworkTransition = null;
    },
  };
}

function assertRuntimeVersion(expected: RuntimeVersion): void {
  const current = getRuntimeVersion();
  if (current.epoch !== expected.epoch || current.network !== expected.network) {
    throw new Error('STALE_NETWORK_SWITCH');
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
  const transition = activeNetworkTransition;
  session = null;
  if (transition) {
    // Keep the transition fence installed until its durable write settles. The lock
    // cancels the staged target identity, while `openSession` remains blocked from
    // reopening the old network against a soon-to-change vault/network pair.
    return { didLock: transition.cancel(), disposal: transition.disposal };
  }
  epoch++;
  if (!previous) return { didLock: false, disposal: Promise.resolve() };
  return { didLock: true, disposal: disposeRuntimeSession(previous) };
}

/**
 * Get the session wallet, building it once if needed. This function deliberately stays
 * non-async: the pending promise is installed before any caller can reach an `await`, so
 * concurrent requests always share one build.
 */
function acquireSessionWallet(): Promise<Wallet> {
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

/** Capture one wallet/network/epoch tuple whose authority can be checked after awaits. */
export function getSessionContext(): Promise<SessionContext> {
  const owner = session;
  if (!owner) return Promise.reject(new Error('LOCKED'));

  return acquireSessionWallet().then((wallet) => {
    assertSessionOwner(owner, wallet);
    return Object.freeze({
      wallet,
      network: owner.network,
      epoch: owner.epoch,
      assertCurrent: () => assertSessionOwner(owner, wallet),
    });
  });
}

function assertSessionOwner(owner: RuntimeSession, wallet: Wallet): void {
  if (session !== owner || owner.wallet !== wallet) {
    throw new Error('LOCKED');
  }
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
export async function ensureFreshVtxos(
  context: SessionContext,
  maxAgeMs = 10_000,
): Promise<void> {
  context.assertCurrent();
  const owner = session;
  const { wallet } = context;
  if (
    !owner ||
    owner.wallet !== wallet ||
    owner.network !== context.network ||
    owner.epoch !== context.epoch
  ) {
    throw new Error('LOCKED');
  }
  if (owner.refreshPromise) return owner.refreshPromise;
  if (Date.now() - owner.lastRefreshMs < maxAgeMs) return;

  const mine = withTimeout(refreshVtxosNow(context), REFRESH_TIMEOUT_MS, 'vtxo refresh');
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

async function refreshVtxosNow(context: SessionContext): Promise<void> {
  const manager = await context.wallet.getContractManager();
  context.assertCurrent();
  await manager.refreshVtxos();
}
