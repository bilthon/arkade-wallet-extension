import { onMessage } from '@/src/messaging';
import {
  registerAutoLock,
  armAutoLock,
  isUnlocked,
  getUnlockedSeed,
  getLockState,
  createWallet,
  importWallet,
  unlock,
  lock,
  getMnemonicForBackup,
} from '@/src/keystore';
import { hasVault, getNetwork as getStoredNetwork } from '@/src/storage';
import {
  buildWallet,
  getAddress,
  getBoardingAddress,
  getBalance,
  send,
} from '@/src/wallet';
import { getSnapshot, setSnapshot, type WalletSnapshot } from '@/src/wallet-cache';

/**
 * Stateless request router (PLAN.md §2/§3). Holds no secret/wallet state in memory
 * between wakes — every read handler rehydrates a `Wallet` from IndexedDB + the
 * in-memory seed on demand. The one persistent in-memory value is the unlocked seed,
 * held in `keystore.ts` module memory (M1) and zeroed on lock/auto-lock.
 *
 * Boundary rule (M1): keystore ops run entirely here; the seed/mnemonic NEVER leaves
 * the SW except the explicit, user-initiated `getMnemonicForBackup` reveal.
 */
export default defineBackground(() => {
  // Track B: arm the idle auto-lock alarm handler (PLAN.md §7, Strict posture).
  registerAutoLock();

  // ── Messaging smoke-test (proves the provider→content→background chain) ──────
  onMessage('ping', ({ data }) => {
    return { pong: true as const, timestamp: Date.now(), echo: data?.echo };
  });

  // ── Keystore (seed stays in the SW) ────────────────────────────────────────
  onMessage('hasVault', () => hasVault());
  onMessage('getLockState', () => getLockState());

  onMessage('createWallet', async ({ data }) => {
    const mnemonic = await createWallet(data.password, data.strength);
    return { mnemonic };
  });

  onMessage('importWallet', async ({ data }) => {
    await importWallet(data.mnemonic, data.password);
    return { ok: true as const };
  });

  onMessage('unlock', async ({ data }) => {
    await unlock(data.password);
    return { ok: true as const };
  });

  onMessage('lock', async () => {
    await lock();
    return { ok: true as const };
  });

  onMessage('getMnemonicForBackup', async ({ data }) => {
    const mnemonic = await getMnemonicForBackup(data.password);
    return { mnemonic };
  });

  // ── Read methods (public results only) ─────────────────────────────────────
  onMessage('getAddress', async () => {
    const wallet = await requireWallet();
    return { address: await getAddress(wallet) };
  });

  onMessage('getBoardingAddress', async () => {
    const wallet = await requireWallet();
    return { boardingAddress: await getBoardingAddress(wallet) };
  });

  onMessage('getBalance', async () => {
    const wallet = await requireWallet();
    return getBalance(wallet);
  });

  onMessage('getNetwork', async () => {
    return { network: await getStoredNetwork() };
  });

  // Cache-first: instant cached read, never touches the operator.
  onMessage('getWalletSnapshot', async () => {
    const network = await getStoredNetwork();
    return { snapshot: await getSnapshot(network) };
  });

  // Live reconciliation: build wallet, read operator, persist + return fresh snapshot.
  onMessage('refreshWalletSnapshot', async () => {
    const wallet = await requireWallet();
    const network = await getStoredNetwork();
    // Addresses are deterministic from the identity; balance is the live operator read.
    const [address, boardingAddress, balance] = await Promise.all([
      getAddress(wallet),
      getBoardingAddress(wallet),
      getBalance(wallet),
    ]);
    const snapshot: WalletSnapshot = {
      network,
      address,
      boardingAddress,
      balance,
      fetchedAt: Date.now(),
    };
    await setSnapshot(snapshot);
    return { snapshot };
  });

  // ── Off-chain send (Track E) ───────────────────────────────────────────────
  // Gated on unlock via requireWallet (re-arms auto-lock). The SW validates
  // address + amount and signs; only the txid crosses back. A thrown
  // SendValidationError / 'LOCKED' / operator error reaches the popup as its message.
  onMessage('send', async ({ data }) => {
    const wallet = await requireWallet();
    return send(wallet, data);
  });

  console.log('[arkade] background ready');
});

/**
 * Build a `Wallet` from the in-memory seed, or throw if locked. Re-arms auto-lock
 * on each sensitive read so an active session keeps the idle window fresh. Throwing
 * 'LOCKED' lets the popup route to the unlock screen rather than show a broken read.
 */
async function requireWallet() {
  const seed = getUnlockedSeed();
  if (!seed || !isUnlocked()) throw new Error('LOCKED');
  await armAutoLock();
  return buildWallet(seed);
}
