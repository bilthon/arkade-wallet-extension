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
  listCoins,
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
import {
  disposeSwaps,
  hasPendingSwaps,
  reconcilePendingSwaps,
  createInvoice,
  getLightningInfo,
  getReceiveStatus,
  getPayQuote,
  payInvoice,
  getPayStatus,
} from '@/src/lightning';
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
 * Stateless request router. Holds no secret/wallet state in memory between wakes —
 * every read handler rehydrates a `Wallet` from IndexedDB + the in-memory seed on
 * demand. The one persistent in-memory value is the unlocked seed, held in
 * `keystore.ts` module memory and zeroed on lock/auto-lock.
 *
 * Boundary rule: keystore ops run entirely here; the seed/mnemonic NEVER leaves
 * the SW except the explicit, user-initiated `getMnemonicForBackup` reveal.
 */
export default defineBackground(() => {
  // Arm the idle auto-lock alarm handler (Strict posture).
  registerAutoLock();
  // Arm the recurring VTXO-renewal alarm (renew-while-unlocked fallback).
  registerRenewal();
  // On lock (manual or auto), notify connected sites their session ended.
  // Reads need the wallet unlocked, so a lock effectively disconnects them.
  onLock(() => {
    void emitToAllConnected('disconnect');
    // The Lightning swap runtime must not outlive the seed it was built from.
    void disposeSwaps();
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
    // Lightning reconcile is best-effort recovery, not part of unlocking itself —
    // a swap-repo read failure must never stop a correct password from unlocking.
    try {
      const network = await getStoredNetwork();
      if (await hasPendingSwaps(network)) {
        const seed = getUnlockedSeed();
        // Fire-and-forget: refreshing statuses (WebSocket + manager start) must not
        // delay the unlock response.
        if (seed) void reconcilePendingSwaps(seed);
      }
    } catch {
      /* best-effort — an unlock must still report success */
    }
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
    // The old network's swap repo + Boltz endpoint are now stale.
    void disposeSwaps();
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
    // Bound the build so a hung operator getInfo can't block for tens of seconds. A build
    // that times out never called getVtxos, so it started no watcher to dispose.
    const wallet = await withTimeout(requireWallet(), REFRESH_STEP_TIMEOUT_MS, 'wallet build');
    try {
      const network = await getStoredNetwork();
      // getBalance() calls wallet.getVtxos(), which spins up a ContractWatcher. Bound the
      // reads so a hung indexer can't hold it open, and always dispose in the finally.
      const [address, boardingAddress, balance] = await withTimeout(
        Promise.all([getAddress(wallet), getBoardingAddress(wallet), getBalance(wallet)]),
        REFRESH_STEP_TIMEOUT_MS,
        'balance read',
      );
      const snapshot: WalletSnapshot = {
        network,
        address,
        boardingAddress,
        balance,
        fetchedAt: Date.now(),
      };
      await setSnapshot(snapshot);
      return { snapshot };
    } finally {
      // Tear down the ContractWatcher this wallet started so it can't reconnect-loop or
      // accumulate across polls. Only disposes the watcher, not the shared IndexedDB.
      await wallet.dispose().catch(() => {});
    }
  });

  // Unlock-gated: lists every VTXO (spendable + needs-renewal + needs-recovery) for the
  // coin-control screen. Read-only; only public DTOs cross back.
  onMessage('listCoins', async () => listCoins(await requireWallet()));

  // ── Off-chain send ─────────────────────────────────────────────────────────
  // Gated on unlock via requireWallet (re-arms auto-lock). The SW validates
  // address + amount and signs; only the txid crosses back. A thrown
  // SendValidationError / 'LOCKED' / operator error reaches the popup as its message.
  // `data.outpoints` (coin control) restricts the send to an exact coin selection.
  onMessage('send', async ({ data }) => {
    const wallet = await requireWallet();
    return send(wallet, data);
  });

  onMessage('sendOnchain', async ({ data }) => {
    const wallet = await requireWallet();
    return sendOnchain(wallet, data);
  });

  // ── Renewal + recovery + onboarding ────────────────────────────────────────
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

  // ── Lightning receive (reverse swap via Boltz) ─────────────────────────────
  // Safe while locked — reads Boltz's public fee/limit endpoints directly.
  onMessage('getLightningInfo', async () => getLightningInfo());

  // Unlock-gated: creating the swap runtime needs the wallet's claim key.
  onMessage('createLightningInvoice', async ({ data }) => {
    const seed = await requireSeed();
    return createInvoice(seed, data);
  });

  // Read-only poll; no unlock gate — works even before the singleton exists.
  onMessage('getLightningReceiveStatus', async ({ data }) => {
    return { status: await getReceiveStatus(data.swapId) };
  });

  // ── Lightning pay (submarine swap via Boltz) ───────────────────────────────
  // Safe while locked — decodes the invoice and reads Boltz's public fee/limit endpoints.
  onMessage('getLightningPayQuote', async ({ data }) => getPayQuote(data));

  // Unlock-gated: funding the swap's VHTLC signs an Arkade send.
  onMessage('payLightningInvoice', async ({ data }) => {
    const seed = await requireSeed();
    return payInvoice(seed, data);
  });

  // Read-only poll; no unlock gate — works even before the singleton exists.
  onMessage('getLightningPayStatus', async ({ data }) => {
    return { status: await getPayStatus(data.swapId) };
  });

  // ── Provider surface ───────────────────────────────────────────────────────
  //
  // The ONLY handlers that take an untrusted origin. Each derives the origin from
  // `sender` (NEVER a body field) and checks the per-origin grant before doing
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

/** Timeout (ms) for a single wallet build or balance read in the SW, so a hung operator
 *  or indexer can't block the refresh. On timeout we fail fast and dispose the wallet. */
const REFRESH_STEP_TIMEOUT_MS = 8000;

/** Reject after `ms` with a labelled error so a hung SDK network call can't stall a handler.
 *  The underlying promise keeps running; callers dispose the wallet regardless. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`refresh timed out (${label})`)), ms),
    ),
  ]);
}

/**
 * The in-memory seed, or throw if locked. Re-arms auto-lock on each sensitive
 * read so an active session keeps the idle window fresh. Throwing 'LOCKED' lets
 * the popup route to the unlock screen rather than show a broken read.
 */
async function requireSeed(): Promise<Uint8Array> {
  const seed = getUnlockedSeed();
  if (!seed || !isUnlocked()) throw new Error('LOCKED');
  await armAutoLock();
  return seed;
}

/** Build a `Wallet` from the in-memory seed, or throw if locked (see {@link requireSeed}). */
async function requireWallet() {
  return buildWallet(await requireSeed());
}
