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
  type ApprovalPayload,
} from './approvals';
import { getNetwork as getStoredNetwork, hasVault } from './storage';
import { isUnlocked } from './keystore';
import { networkConfig } from './wallet';
import { encodeProviderError, type ProviderEvent } from './provider-api';
import { PROVIDER_EVENT_TYPE, type ProviderEventMessage } from './provider-events';
import {
  signMessageBIP322,
  validatePsbtForSigning,
  signPsbtPartial,
  buildInspectContext,
  isSighashShaped,
  SignMessageError,
} from './signing';
import { PsbtRejectedError } from './psbt-inspect';
import { networks, type Wallet } from '@arkade-os/sdk';

/**
 * Provider-facing handler logic. Every function here takes the message
 * `sender` and derives the origin from it — NEVER from a body field. It then
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

/** Throw a typed provider error the content bridge passes through to the web app. */
function providerError(
  code: Parameters<typeof encodeProviderError>[0],
  message: string,
): never {
  throw new Error(encodeProviderError(code, message));
}

/**
 * Resolve the SW-verified origin from the sender, mapping an `OriginError` to a typed
 * `BAD_ORIGIN` provider error (so a null/opaque/http page gets a clean rejection, not
 * an internal stack). This is the ONLY place origins enter the provider path.
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
 * separate browser window the site can't iframe or overlay (the page also sets CSP
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
 * Handle a provider `connect`. Derives the origin, requires a wallet to exist and be
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

  const decision = await requestApprovalSafe({ kind: 'connect' }, origin);
  if (!decision.approved) {
    providerError('REJECTED', 'The connection request was declined.');
  }

  // Approved → derive the account address and persist the read-only grant.
  const wallet = await buildWalletForRead();
  const address = await wallet.getAddress();
  const grant = await grantConnect(origin, [address]);
  return { accounts: grant.accounts };
}

/**
 * Wrap `requestApproval` so a BUSY collision surfaces as a typed provider error and a
 * decline/close/revoke surfaces as REJECTED. Shared by every approval kind
 * (connect / signMessage / signPsbt) so the one-window-at-a-time + typed-error contract
 * is identical across them.
 */
async function requestApprovalSafe(payload: ApprovalPayload, origin: string) {
  try {
    return await requestApproval(payload, origin, openApprovalWindow);
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
  await rejectApprovalForOrigin(origin, 'Disconnected by the site.');
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

// ─── signing (always re-prompts; NOT granted by connect) ──────────────────────

/**
 * Gate a signing call. Unlike a read, signing is NEVER auto-granted by `connect` — but
 * we still require the origin to be a CONNECTED site (so a never-connected page can't
 * pop a signing prompt) and the wallet unlocked. Returns the origin; throws typed
 * NOT_CONNECTED/LOCKED otherwise. The per-call approval window is opened by the handler.
 */
async function requireForSigning(sender: MessageSenderLike | undefined): Promise<string> {
  const origin = originFromSender(sender);
  if (!(await originIsConnected(origin))) {
    providerError('NOT_CONNECTED', 'This site is not connected. Call connect() first.');
  }
  if (!isUnlocked()) {
    providerError('LOCKED', 'The Arkade wallet is locked. Unlock it to continue.');
  }
  // One window at a time — reject a concurrent request up front (matches connect).
  if (currentInFlight()) {
    providerError('BUSY', 'Another approval is already open. Try again in a moment.');
  }
  return origin;
}

/**
 * `signMessage` — BIP322/Schnorr message signing. ALWAYS re-prompts (a fresh approval
 * window every call; never granted by connect). The approval window shows the message
 * verbatim + the SW-derived origin. We reject sighash-shaped input (a bare 32-byte hash)
 * BEFORE prompting, so the user never sees — and can never approve — a blind tx sign.
 * Returns the base64 BIP322 signature. The seed never leaves the SW.
 */
export async function handleSignMessage(
  sender: MessageSenderLike | undefined,
  message: unknown,
  buildWallet: () => Promise<Wallet>,
): Promise<{ signature: string }> {
  const origin = await requireForSigning(sender);

  if (typeof message !== 'string') {
    providerError('BAD_REQUEST', 'signMessage expects a string message.');
  }

  // Pre-validate (empty / sighash-shaped) BEFORE prompting — a dangerous request is
  // rejected outright, never shown as approvable.
  assertSignableMessage(message);

  const session = await getSigningSession(buildWallet);
  const decision = await requestApprovalSafe({ kind: 'signMessage', message }, origin);
  if (!decision.approved) {
    providerError('REJECTED', 'The signature request was declined.');
  }

  return withUnchangedSigningSession(session, buildWallet, async ({ wallet, network }) => {
    try {
      // Anchor the BIP322 signature to the wallet's ACTIVE network so a verifier checking
      // against the user's real (testnet/regtest/mainnet) taproot address succeeds.
      const signature = await signMessageBIP322(wallet.identity, message, networks[network]);
      return { signature };
    } catch (err) {
      if (err instanceof SignMessageError) providerError('BAD_REQUEST', err.message);
      throw err;
    }
  });
}

/**
 * Throw a typed BAD_REQUEST if the message is empty or sighash-shaped — run BEFORE the
 * prompt so a dangerous request is never shown as approvable. (`signMessageBIP322` runs
 * the same checks again at sign time; this is the pre-prompt guard.)
 */
function assertSignableMessage(message: string): void {
  if (message.trim().length === 0) {
    providerError('BAD_REQUEST', 'Cannot sign an empty message.');
  }
  if (isSighashShaped(message)) {
    providerError(
      'BAD_REQUEST',
      'This looks like a transaction hash, not a message. For your safety the wallet ' +
        'only signs human-readable messages here, never a raw 32-byte hash.',
    );
  }
}

/**
 * `signPsbt` — partial-sign a PSBT and return it UNFINALIZED. ALWAYS re-prompts. The SW
 * PARSES + VALIDATES the PSBT itself (never a site-supplied summary): it decodes outputs,
 * detects own-change by re-derivation, computes totals + fee, flags dangers, and
 * classifies each signed input as an own-coin spend or a contract co-sign. Undecodable
 * PSBTs / bad indexes / inputs we can't sign / fees over the bound are rejected before any
 * prompt. On approve we add ONLY our partial Schnorr `tapScriptSig` (via `Identity.sign`)
 * and return the PSBT unfinalized, so the other N-of-N parties + the operator co-sign in
 * sequence. Accepts an Arkade checkpoint PSBT (a cooperative spend is two prompts).
 *
 * `allowHighFee` lets a second call override the fee-sanity rejection (explicit override).
 */
export async function handleSignPsbt(
  sender: MessageSenderLike | undefined,
  params: { psbt?: unknown; inputIndexes?: unknown; allowHighFee?: unknown },
  buildWallet: () => Promise<Wallet>,
): Promise<{ psbt: string }> {
  const origin = await requireForSigning(sender);

  const psbt = params?.psbt;
  const inputIndexes = params?.inputIndexes;
  if (typeof psbt !== 'string' || psbt.length === 0) {
    providerError('BAD_REQUEST', 'signPsbt expects a base64/hex psbt string.');
  }
  if (!Array.isArray(inputIndexes) || !inputIndexes.every((i) => Number.isInteger(i))) {
    providerError('BAD_REQUEST', 'signPsbt expects inputIndexes: number[].');
  }
  const allowHighFee = params?.allowHighFee === true;

  // Capture one stable wallet/network pair for inspection. A second check after approval
  // prevents this signer from surviving a lock, unlock, or network switch while the user
  // has the approval window open.
  const session = await getSigningSession(buildWallet);
  const { wallet, network } = session;
  const dustSats = await operatorDust(wallet);
  const ctx = await buildInspectContext(wallet, network, dustSats);

  // SW-side validate → the summary is what the user approves (NOT a site claim).
  let summary;
  try {
    ({ summary } = validatePsbtForSigning(psbt as string, inputIndexes as number[], ctx, {
      allowHighFee,
    }));
  } catch (err) {
    if (err instanceof PsbtRejectedError) providerError('BAD_REQUEST', err.message);
    throw err;
  }

  const decision = await requestApprovalSafe({ kind: 'signPsbt', summary }, origin);
  if (!decision.approved) {
    providerError('REJECTED', 'The signing request was declined.');
  }

  return withUnchangedSigningSession(session, buildWallet, async ({ wallet: currentWallet }) => {
    // Re-parse + sign from the SAME psbt string we inspected, add only our partial sig,
    // return unfinalized.
    const signedPsbt = await signPsbtPartial(
      currentWallet,
      psbt as string,
      inputIndexes as number[],
    );
    return { psbt: signedPsbt };
  });
}

interface SigningSession {
  wallet: Wallet;
  network: import('@arkade-os/sdk').NetworkName;
}

/**
 * Capture a wallet and its active network without accepting a pair crossed by a concurrent
 * network switch. Signing performs a second authorization after user approval.
 */
async function getSigningSession(
  buildWallet: () => Promise<Wallet>,
): Promise<SigningSession> {
  const network = await getStoredNetwork();
  const wallet = await requireCurrentWallet(buildWallet);
  if ((await getStoredNetwork()) !== network) {
    providerError('LOCKED', 'The wallet session changed. Try the request again.');
  }
  return { wallet, network };
}

/**
 * Reauthorize after approval and invoke `action` in the same continuation as the final
 * wallet/network check. Nothing may await between that check and starting the signer.
 */
async function withUnchangedSigningSession<T>(
  expected: SigningSession,
  buildWallet: () => Promise<Wallet>,
  action: (current: SigningSession) => Promise<T>,
): Promise<T> {
  const networkBefore = await getStoredNetwork();
  let currentWallet: Wallet;
  try {
    currentWallet = await buildWallet();
  } catch (err) {
    if (err instanceof Error && err.message === 'LOCKED') {
      providerError('LOCKED', 'The Arkade wallet was locked. Unlock it and try again.');
    }
    throw err;
  }
  const networkAfter = await getStoredNetwork();
  if (
    !isUnlocked() ||
    currentWallet !== expected.wallet ||
    networkBefore !== expected.network ||
    networkAfter !== expected.network
  ) {
    providerError('LOCKED', 'The wallet session changed. Try the request again.');
  }
  return action({ wallet: currentWallet, network: networkAfter });
}

/** Map a lock that lands after the approval gate to the provider's typed LOCKED error. */
async function requireCurrentWallet(buildWallet: () => Promise<Wallet>): Promise<Wallet> {
  try {
    return await buildWallet();
  } catch (err) {
    if (err instanceof Error && err.message === 'LOCKED') {
      providerError('LOCKED', 'The Arkade wallet was locked. Unlock it and try again.');
    }
    throw err;
  }
}

/** The operator's dust floor in sats (`info.dust`), or a safe default if unreachable. */
async function operatorDust(wallet: Wallet): Promise<number> {
  try {
    const info = await wallet.arkProvider.getInfo();
    return Number(info.dust);
  } catch {
    return 330; // standard P2TR dust; only used to label tiny outputs
  }
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
 * Push a provider event to every tab at this `origin`. Best-effort: a tab with no
 * content script (or a closed one) just rejects the sendMessage, which we swallow.
 * Used for `disconnect` (revoke/lock) and could carry `accountsChanged`.
 *
 * Least-privilege (security review): we SCOPE the `tabs.query` to a match pattern
 * built from `origin` (`https://host/*`) instead of `tabs.query({})`, so we never
 * enumerate every open tab's URL — only tabs at an origin we already have a relationship
 * with are ever read. `origin` here is always an SW-derived, grant-keyed origin (from
 * `deriveOrigin`/`listGrants`), never a page-supplied string. The exact-origin post-
 * filter still runs because match patterns ignore the port (so a port-bearing origin
 * like `https://host:8443` wouldn't be distinguished by the pattern alone).
 */
export async function emitToOrigin(
  origin: string,
  event: ProviderEvent,
  data?: unknown,
): Promise<void> {
  const pattern = originMatchPattern(origin);
  if (!pattern) return;
  const message: ProviderEventMessage = { type: PROVIDER_EVENT_TYPE, event, data };
  let tabs: { id?: number; url?: string }[] = [];
  try {
    tabs = await browser.tabs.query({ url: pattern });
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
 * Build a host-scoped tab match pattern (`scheme://host/*`) from an SW-derived origin,
 * or null if the origin can't be parsed. Drops the port — Chrome match patterns don't
 * carry one — which is why `emitToOrigin` keeps the exact-origin post-filter.
 */
function originMatchPattern(origin: string): string | null {
  try {
    const url = new URL(origin);
    return `${url.protocol}//${url.hostname}/*`;
  } catch {
    return null;
  }
}

/**
 * Broadcast a provider event to ALL connected origins (e.g. `networkChanged` on a
 * network switch — every connected site's view of the network changed).
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
