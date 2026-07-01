import type { NetworkName } from '@arkade-os/sdk';
import type { AdjustedBalance } from './vtxo-state';

/**
 * Shared provider types. Mirrors the SDK method names so the provider stays a thin
 * pass-through (no translation layer that can drift). Covers connect + the read
 * surface and the signing surface (`signMessage` + `signPsbt`). `sendBitcoin`
 * (off-chain) + on-chain/Lightning are out of this generic provider — they map to
 * their own flows.
 *
 * These types are imported by both the MAIN-world provider (to type `window.arkadeWallet`)
 * and the background (to type the provider message results), so the wire shape is one source.
 */

/** Network info returned to a web app: the active network name + the operator URL. */
export interface NetworkInfo {
  network: NetworkName;
  arkServerUrl: string;
}

/** Raw user key — x-only (32B) + compressed (33B), hex. Web apps building their own
 * VtxoScripts (escrow/HTLC) need this; the Arkade address encodes a tweaked key. */
export interface PublicKeyInfo {
  xOnly: string;
  compressed: string;
}

/** The provider events a web app can subscribe to via `on()`. */
export type ProviderEvent = 'accountsChanged' | 'networkChanged' | 'disconnect';

/**
 * The `window.arkadeWallet` surface. Each method below maps to a `provider*` message
 * handled in the background behind origin + grant gating. Reads require an active grant;
 * the two signing methods are NEVER auto-granted — they re-prompt on every call.
 */
export interface ArkadeWalletProvider {
  // Connection (read-only grant) — `connect` prompts; the rest read the grant.
  connect(): Promise<string[]>;
  disconnect(): Promise<void>;
  isConnected(): Promise<boolean>;
  getAccounts(): Promise<string[]>;

  // Wallet info (read-only; require an active grant + unlocked wallet).
  getAddress(): Promise<string>;
  getBoardingAddress(): Promise<string>;
  getPublicKey(): Promise<PublicKeyInfo>;
  getBalance(): Promise<AdjustedBalance>;
  getNetwork(): Promise<NetworkInfo>;

  // Signing (each re-prompts; never granted by connect).
  /** BIP322/Schnorr message signing. Returns the base64 signature. Rejects a
   *  sighash-shaped (bare 32-byte) message — only human-readable text is signed here. */
  signMessage(params: { message: string }): Promise<string>;
  /** Partial-sign the given inputs and return the PSBT UNFINALIZED (base64). The SW
   *  validates the PSBT itself; for a co-signed VtxoScript leaf it adds only our
   *  Schnorr tapScriptSig so the other parties sign in sequence. */
  signPsbt(params: { psbt: string; inputIndexes: number[] }): Promise<string>;

  // Events.
  on(event: ProviderEvent, handler: (...args: unknown[]) => void): void;
  removeListener(event: ProviderEvent, handler: (...args: unknown[]) => void): void;
}

/**
 * Typed error codes the background returns to the web app so the page can branch:
 *  • LOCKED        — wallet exists but is locked; the user must unlock.
 *  • NOT_CONNECTED — the origin has no grant (call connect() first, or it was revoked).
 *  • REJECTED      — the user declined the approval.
 *  • NO_WALLET     — no wallet has been created yet.
 *  • BUSY          — another approval window is already open.
 *  • BAD_ORIGIN    — the request origin is null/opaque/insecure (cannot connect).
 *  • BAD_REQUEST   — the call's arguments are malformed or unsafe (e.g. a sighash-shaped
 *                    signMessage, an undecodable PSBT, an input we can't sign).
 */
export type ProviderErrorCode =
  | 'LOCKED'
  | 'NOT_CONNECTED'
  | 'REJECTED'
  | 'NO_WALLET'
  | 'BUSY'
  | 'BAD_ORIGIN'
  | 'BAD_REQUEST';

/** Marker prefix so the provider can re-throw a code-tagged error to the web app. */
export const PROVIDER_ERROR_PREFIX = 'ARKADE_PROVIDER_ERROR:';

/** Build the wire string for a typed provider error (background → content → page). */
export function encodeProviderError(code: ProviderErrorCode, message: string): string {
  return `${PROVIDER_ERROR_PREFIX}${code}:${message}`;
}

/** Parse a wire error string back into {code, message}, or null if it isn't one. */
export function decodeProviderError(
  raw: string,
): { code: ProviderErrorCode; message: string } | null {
  if (!raw.startsWith(PROVIDER_ERROR_PREFIX)) return null;
  const rest = raw.slice(PROVIDER_ERROR_PREFIX.length);
  const sep = rest.indexOf(':');
  if (sep === -1) return null;
  return { code: rest.slice(0, sep) as ProviderErrorCode, message: rest.slice(sep + 1) };
}
