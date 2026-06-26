import { deriveOrigin, OriginError, type MessageSenderLike } from './origin';
import {
  grantConnect,
  getGrant,
  revokeGrant,
  isConnected as originIsConnected,
  isMethodGranted,
  type GrantedMethod,
} from './permissions';
import {
  requestApproval,
  resolveApproval,
  rejectApprovalForOrigin,
  currentInFlight,
  onWindowClosed,
  type PendingRequest,
} from './approvals';
import { getNetwork as getStoredNetwork, hasVault } from './storage';
import { isUnlocked } from './keystore';
import { networkConfig } from './wallet';
import { encodeProviderError, type ProviderEvent } from './provider-api';
import { PROVIDER_EVENT_TYPE, type ProviderEventMessage } from './provider-events';

/**
 * Dapp-facing handler logic (Track E2a). Every function here takes the message
 * `sender` and derives the origin from it — NEVER from a body field (M4). It then
 * checks the per-origin grant and the wallet lock state, and returns public results
 * only. The seed/mnemonic never reach this layer (it lives in keystore.ts).
 *
 * `buildWalletForRead` is injected by the background (it owns `requireWallet`/the
 * unlocked seed) so this module stays free of the keystore-memory coupling and is
 * unit-testable with a fake wallet + fake sender.
 */

/**
 * The minimal wallet view `handleConnect` needs: the Arkade account address to record
 * in the grant + show on the approval screen. Kept narrow (just `getAddress`) so the
 * SDK `Wallet` satisfies it structurally and tests can supply a one-method fake. The
 * other read methods don't go through here — the background gates them and reads from
 * the SDK `Wallet` directly.
 */
export interface ReadWallet {
  getAddress(): Promise<string>;
}

/** Throw a typed provider error the content bridge passes through to the dapp. */
function providerError(
  code: Parameters<typeof encodeProviderError>[0],
  message: string,
): never {
  throw new Error(encodeProviderError(code, message));
}

/**
 * Resolve the SW-verified origin from the sender, mapping an `OriginError` to a typed
 * `BAD_ORIGIN` provider error (so a null/opaque/http page gets a clean rejection, not
 * an internal stack). This is the ONLY place origins enter the dapp path.
 */
export function originFromSender(sender: MessageSenderLike | undefined): string {
  try {
    return deriveOrigin(sender);
  } catch (err) {
    if (err instanceof OriginError) {
      providerError('BAD_ORIGIN', err.message);
    }
    throw err;
  }
}

// ─── connect ─────────────────────────────────────────────────────────────────

/**
 * Open the dedicated approval WINDOW for a pending request and return its window id.
 * A real `chrome.windows.create` to the extension's approval page with the requestId
 * in the query string. Centered popup, fixed size, focused. Anti-clickjacking: a
 * separate browser window the dapp can't iframe or overlay (the page also sets CSP
 * `frame-ancestors 'none'`).
 */
export async function openApprovalWindow(request: PendingRequest): Promise<number | null> {
  // getURL is typed to known public paths; the approval page is a WXT HTML entrypoint
  // (/approval.html) but the query string makes the literal type not match — build the
  // base URL from the known path, then append the query.
  const base = browser.runtime.getURL('/approval.html');
  const url = `${base}?requestId=${encodeURIComponent(request.requestId)}`;
  const win = await browser.windows.create({
    url,
    type: 'popup',
    width: 380,
    height: 600,
    focused: true,
  });
  return win?.id ?? null;
}

/**
 * Handle a dapp `connect`. Derives the origin (M4), requires a wallet to exist and be
 * unlocked, then — if not already connected — opens the approval window and awaits the
 * user's decision. On approve, persists a READ-ONLY grant and returns the account(s).
 * On reject, throws a typed `REJECTED`. An already-connected origin short-circuits
 * (idempotent connect) without re-prompting.
 */
export async function handleConnect(
  sender: MessageSenderLike | undefined,
  buildWalletForRead: () => Promise<ReadWallet>,
): Promise<{ accounts: string[] }> {
  const origin = originFromSender(sender);

  if (!(await hasVault())) {
    providerError('NO_WALLET', 'No Arkade wallet has been set up yet.');
  }

  // Already connected → idempotent, no prompt. Return the granted accounts.
  const existing = await getGrant(origin);
  if (existing) {
    return { accounts: existing.accounts };
  }

  // Reject a concurrent request (one window at a time) BEFORE we read the wallet.
  if (currentInFlight()) {
    providerError('BUSY', 'Another approval is already open. Try again in a moment.');
  }

  // Wallet must be unlocked to derive the account address shown on the approval screen.
  if (!isUnlocked()) {
    providerError('LOCKED', 'Unlock your Arkade wallet, then connect again.');
  }

  const decision = await requestApprovalSafe(origin);
  if (!decision.approved) {
    providerError('REJECTED', 'The connection request was declined.');
  }

  // Approved → derive the account address and persist the read-only grant.
  const wallet = await buildWalletForRead();
  const address = await wallet.getAddress();
  const grant = await grantConnect(origin, [address]);
  return { accounts: grant.accounts };
}

/** Wrap `requestApproval` so a BUSY collision surfaces as a typed provider error. */
async function requestApprovalSafe(origin: string) {
  try {
    return await requestApproval('connect', origin, openApprovalWindow);
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as { code?: string }).code === 'BUSY') {
      providerError('BUSY', 'Another approval is already open. Try again in a moment.');
    }
    // A rejected pending request (revoke/close) reaches here too — surface as REJECTED.
    providerError('REJECTED', err instanceof Error ? err.message : 'Request was cancelled.');
  }
}

// ─── disconnect ────────────────────────────────────────────────────────────────

/** Revoke the calling origin's own grant + reject any of its pending requests. Emits
 * a `disconnect` event to that origin's pages. Idempotent. */
export async function handleDisconnect(
  sender: MessageSenderLike | undefined,
): Promise<{ ok: true }> {
  const origin = originFromSender(sender);
  await rejectApprovalForOrigin(origin, 'Disconnected by the dapp.');
  await revokeGrant(origin);
  await emitToOrigin(origin, 'disconnect');
  return { ok: true };
}

// ─── read methods (grant + unlock gated) ─────────────────────────────────────

/**
 * Gate a read method: derive origin, require the origin's grant to include `method`,
 * and require the wallet unlocked. Returns the origin on success; throws a typed
 * `NOT_CONNECTED`/`LOCKED` otherwise. Reads do NOT re-prompt.
 */
export async function requireRead(
  sender: MessageSenderLike | undefined,
  method: GrantedMethod,
): Promise<string> {
  const origin = originFromSender(sender);
  if (!(await isMethodGranted(origin, method))) {
    providerError('NOT_CONNECTED', 'This site is not connected. Call connect() first.');
  }
  if (!isUnlocked()) {
    providerError('LOCKED', 'The Arkade wallet is locked. Unlock it to continue.');
  }
  return origin;
}

/** `getAccounts`: the grant's accounts (empty array when not connected — no throw,
 * matching the common provider convention that getAccounts is a soft read). */
export async function handleGetAccounts(
  sender: MessageSenderLike | undefined,
): Promise<{ accounts: string[] }> {
  const origin = originFromSender(sender);
  const grant = await getGrant(origin);
  return { accounts: grant?.accounts ?? [] };
}

/** `isConnected`: whether the calling origin currently has a grant. Never throws on
 * an opaque origin — a non-connectable origin is simply "not connected". */
export async function handleIsConnected(
  sender: MessageSenderLike | undefined,
): Promise<{ connected: boolean }> {
  let origin: string;
  try {
    origin = deriveOrigin(sender);
  } catch {
    return { connected: false };
  }
  return { connected: await originIsConnected(origin) };
}

/** `getNetwork`: active network + operator URL (read-gated). */
export async function handleGetNetwork(
  sender: MessageSenderLike | undefined,
): Promise<{ network: import('@arkade-os/sdk').NetworkName; arkServerUrl: string }> {
  await requireRead(sender, 'getNetwork');
  const network = await getStoredNetwork();
  return { network, arkServerUrl: networkConfig(network).arkServerUrl };
}

// ─── connected-sites management (popup Settings — trusted, no origin gate) ────

/** Revoke a site from the popup. Rejects its pending request + emits disconnect. */
export async function revokeSite(origin: string): Promise<void> {
  await rejectApprovalForOrigin(origin, 'Disconnected from Settings.');
  await revokeGrant(origin);
  await emitToOrigin(origin, 'disconnect');
}

// ─── events ──────────────────────────────────────────────────────────────────

/**
 * Push a provider event to every tab whose page origin matches `origin`. Best-effort:
 * a tab with no content script (or a closed one) just rejects the sendMessage, which
 * we swallow. Used for `disconnect` (revoke/lock) and could carry `accountsChanged`.
 */
export async function emitToOrigin(
  origin: string,
  event: ProviderEvent,
  data?: unknown,
): Promise<void> {
  const message: ProviderEventMessage = { type: PROVIDER_EVENT_TYPE, event, data };
  let tabs: { id?: number; url?: string }[] = [];
  try {
    tabs = await browser.tabs.query({});
  } catch {
    return;
  }
  await Promise.all(
    tabs
      .filter((t) => t.id != null && t.url && safeOrigin(t.url) === origin)
      .map((t) => browser.tabs.sendMessage(t.id!, message).catch(() => undefined)),
  );
}

/**
 * Broadcast a provider event to ALL connected origins (e.g. `networkChanged` on a
 * network switch — every connected dapp's view of the network changed).
 */
export async function emitToAllConnected(
  event: ProviderEvent,
  data?: unknown,
  listOrigins: () => Promise<string[]> = listGrantedOrigins,
): Promise<void> {
  const origins = await listOrigins();
  await Promise.all(origins.map((o) => emitToOrigin(o, event, data)));
}

async function listGrantedOrigins(): Promise<string[]> {
  const { listGrants } = await import('./permissions');
  return (await listGrants()).map((g) => g.origin);
}

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// Re-exports the background wires to chrome.windows / approval-response handling.
export { resolveApproval, onWindowClosed };
