import type { Wallet } from '@arkade-os/sdk';
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
  prepareNetworkSwitch,
} from '@/src/keystore';
import { hasVault, getNetwork as getStoredNetwork } from '@/src/storage';
import {
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
import { getSessionWallet, invalidateSessionWallet, ensureFreshVtxos } from '@/src/wallet-runtime';
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
    // Neither the session wallet nor the Lightning swap runtime may outlive the seed
    // they were built from. `invalidateSessionWallet` disposes the wallet's contract
    // manager/watcher; without also dropping the Lightning runtime here, a surviving
    // `ArkadeSwaps` would silently rebuild them on its next call.
    void invalidateSessionWallet();
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
        // Fire-and-forget: refreshing statuses (WebSocket + manager start) must not
        // delay the unlock response.
        void reconcilePendingSwaps();
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
    // Check the password first. A wrong one throws here, before we touch either
    // runtime, so a typo can't stop a Lightning swap that is mid-flight. `null`
    // means we are already on this network, so there is nothing to do at all.
    const prepared = await prepareNetworkSwitch(data.network, data.password);
    if (!prepared) return { ok: true as const };

    // Both runtimes are keyed by the network baked into their operator/Boltz config,
    // so drop them around the write — nothing should keep building against a network
    // storage is about to disagree with.
    void invalidateSessionWallet();
    void disposeSwaps();
    await prepared.commit();
    // Invalidate again: anything that started building during the write (a race, not
    // the common case) must not survive into the new network either.
    void invalidateSessionWallet();
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

  // Live reconciliation: read operator, persist + return fresh snapshot. Concurrent
  // callers (the popup's 15s poll racing a manual refresh, or another poll tick)
  // join the same `getSessionWallet`/`ensureFreshVtxos` calls rather than each
  // starting their own build or reconciliation; the timeouts that bound a hung
  // build or a hung indexer now live inside the runtime, not this handler.
  onMessage('refreshWalletSnapshot', async () => {
    // Capture the network we're refreshing so we can tell, once the reads finish,
    // whether it moved underneath us.
    const network = await getStoredNetwork();
    const wallet = await requireWallet();
    // maxAgeMs 0 forces a real reconciliation: an explicit user-facing refresh must
    // not be answered from the freshness window, though it still joins a
    // reconciliation already in flight from another caller.
    await ensureFreshVtxos(wallet, 0);
    const [address, boardingAddress, balance] = await Promise.all([
      getAddress(wallet),
      getBoardingAddress(wallet),
      getBalance(wallet),
    ]);

    if ((await getStoredNetwork()) !== network) {
      // A network switch landed while this refresh was running. The wallet and
      // reads above belong to the network we started on, not the current one, so
      // they must never be written as the current per-network cache entry.
      throw new Error('Network changed during refresh');
    }

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

  // Unlock-gated: lists every VTXO (spendable + needs-renewal + needs-recovery) for the
  // coin-control screen. Read-only; only public DTOs cross back. The shared wallet no
  // longer gets an implicit sync from construction, so ask for one before reading.
  onMessage('listCoins', async () => {
    const wallet = await requireWallet();
    await ensureFreshVtxos(wallet);
    return listCoins(wallet);
  });

  // ── Off-chain send ─────────────────────────────────────────────────────────
  // Gated on unlock via requireWallet (re-arms auto-lock). The SW validates
  // address + amount and signs; only the txid crosses back. A thrown
  // SendValidationError / 'LOCKED' / operator error reaches the popup as its message.
  // `data.outpoints` (coin control) restricts the send to an exact coin selection.
  onMessage('send', async ({ data }) => {
    const wallet = await requireWallet();
    await ensureFreshVtxos(wallet); // coin selection needs a live view of what's spendable
    return send(wallet, data);
  });

  onMessage('sendOnchain', async ({ data }) => {
    const wallet = await requireWallet();
    await ensureFreshVtxos(wallet); // coin selection needs a live view of what's spendable
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
    await requireUnlocked();
    return createInvoice(data);
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
    await requireUnlocked();
    return payInvoice(data);
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

/**
 * Throw if locked, otherwise re-arm auto-lock so an active session keeps the
 * idle window fresh. Throwing 'LOCKED' lets the popup route to the unlock
 * screen rather than show a broken read. Used by the Lightning handlers, which
 * need the wallet unlocked but read the seed themselves through
 * `getSessionWallet()` rather than taking it from here.
 */
async function requireUnlocked(): Promise<void> {
  const seed = getUnlockedSeed();
  if (!seed || !isUnlocked()) throw new Error('LOCKED');
  await armAutoLock();
}

/**
 * The shared session wallet, or throw if locked. Re-arms auto-lock first so an
 * active session keeps the idle window fresh — every route through here counts
 * as user activity. No seed or network re-derivation happens at this call site;
 * `getSessionWallet()` owns both, so a lock or network switch racing this call
 * is caught there rather than re-implemented here.
 */
async function requireWallet(): Promise<Wallet> {
  if (!isUnlocked()) throw new Error('LOCKED');
  await armAutoLock();
  return getSessionWallet();
}
