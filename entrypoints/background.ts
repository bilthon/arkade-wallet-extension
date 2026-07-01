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
  onLock,
  getMnemonicForBackup,
  switchNetwork,
} from '@/src/keystore';
import { hasVault, getNetwork as getStoredNetwork } from '@/src/storage';
import {
  buildWallet,
  getAddress,
  getBoardingAddress,
  getBalance,
  getPublicKey,
  send,
  sendOnchain,
  renewExpiringVtxos,
  recoverExpiredVtxos,
  onboardBoarding,
  getTransactionHistory,
} from '@/src/wallet';
import { getSnapshot, setSnapshot, type WalletSnapshot } from '@/src/wallet-cache';
import {
  registerRenewal,
  getRenewalWarning,
  RENEW_MARGIN_MS,
} from '@/src/renewal';
import { listGrants } from '@/src/permissions';
import { getPendingRequest } from '@/src/approvals';
import {
  handleConnect,
  handleDisconnect,
  handleIsConnected,
  handleGetAccounts,
  handleGetNetwork,
  handleSignMessage,
  handleSignPsbt,
  requireRead,
  revokeSite,
  emitToAllConnected,
  resolveApproval,
  onWindowClosed,
} from '@/src/provider-handlers';

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
  // Track F: arm the recurring VTXO-renewal alarm (renew-while-unlocked fallback).
  registerRenewal();
  // Track E2a: on lock (manual or auto), notify connected sites their session ended.
  // Reads need the wallet unlocked, so a lock effectively disconnects them.
  onLock(() => {
    void emitToAllConnected('disconnect');
  });

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

  onMessage('switchNetwork', async ({ data }) => {
    await switchNetwork(data.network, data.password);
    // Operator network changed → notify connected sites so they don't keep acting on the
    // old network (cached address/PSBTs would target the wrong operator).
    await emitToAllConnected('networkChanged', { network: data.network });
    return { ok: true as const };
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

  onMessage('sendOnchain', async ({ data }) => {
    const wallet = await requireWallet();
    return sendOnchain(wallet, data);
  });

  // ── Renewal + recovery + onboarding (Track F) ──────────────────────────────
  // All sign, so all go through requireWallet (unlock-gated; throws 'LOCKED').
  onMessage('renewNow', async () => {
    const wallet = await requireWallet();
    return renewExpiringVtxos(wallet, RENEW_MARGIN_MS);
  });

  // Recover swept/already-expired coins — the operator re-issues them (distinct from
  // renewal, which only refreshes still-valid coins).
  onMessage('recoverNow', async () => {
    const wallet = await requireWallet();
    return recoverExpiredVtxos(wallet);
  });

  onMessage('onboardNow', async () => {
    const wallet = await requireWallet();
    return onboardBoarding(wallet);
  });

  // Read-only, safe while locked — just returns cached counts for the UI.
  onMessage('getRenewalWarning', async () => {
    return { warning: await getRenewalWarning() };
  });

  onMessage('getTransactionHistory', async () => getTransactionHistory(await requireWallet()));

  // ── Provider surface (Track E2a) ───────────────────────────────────────────
  //
  // The ONLY handlers that take an untrusted origin. Each derives the origin from
  // `sender` (M4 — NEVER a body field) and checks the per-origin grant before doing
  // any work. `connect` opens the approval window; the reads are grant + unlock gated
  // and return typed LOCKED/NOT_CONNECTED/BAD_ORIGIN the web app can handle.

  onMessage('providerConnect', ({ sender }) => handleConnect(sender, requireWallet));
  onMessage('providerDisconnect', ({ sender }) => handleDisconnect(sender));
  onMessage('providerIsConnected', ({ sender }) => handleIsConnected(sender));
  onMessage('providerGetAccounts', ({ sender }) => handleGetAccounts(sender));

  onMessage('providerGetAddress', async ({ sender }) => {
    await requireRead(sender, 'getAddress');
    return { address: await getAddress(await requireWallet()) };
  });

  onMessage('providerGetBoardingAddress', async ({ sender }) => {
    await requireRead(sender, 'getBoardingAddress');
    return { boardingAddress: await getBoardingAddress(await requireWallet()) };
  });

  onMessage('providerGetPublicKey', async ({ sender }) => {
    await requireRead(sender, 'getPublicKey');
    return getPublicKey(await requireWallet());
  });

  onMessage('providerGetBalance', async ({ sender }) => {
    await requireRead(sender, 'getBalance');
    return getBalance(await requireWallet());
  });

  onMessage('providerGetNetwork', ({ sender }) => handleGetNetwork(sender));

  // Signing — never auto-granted by connect; each opens its own approval window. The SW
  // validates the request, signs only on approve, and returns only the public result.
  onMessage('providerSignMessage', ({ sender, data }) =>
    handleSignMessage(sender, data.message, requireWallet),
  );
  onMessage('providerSignPsbt', ({ sender, data }) => handleSignPsbt(sender, data, requireWallet));

  // ── Approval window ↔ background (trusted extension page) ──────────────────
  onMessage('getApprovalRequest', async ({ data }) => {
    return { request: await getPendingRequest(data.requestId) };
  });

  onMessage('approvalResponse', async ({ data }) => {
    await resolveApproval(data.requestId, { approved: data.approved });
    return { ok: true as const };
  });

  // When the approval window is closed without a decision, reject the web app's promise.
  browser.windows.onRemoved.addListener((windowId) => {
    void onWindowClosed(windowId);
  });

  // ── Connected-sites management (popup Settings — trusted) ──────────────────
  onMessage('listConnectedSites', async () => {
    return { grants: await listGrants() };
  });

  onMessage('revokeConnectedSite', async ({ data }) => {
    await revokeSite(data.origin);
    return { ok: true as const };
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
