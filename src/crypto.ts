import { generateMnemonic as genMnemonic, validateMnemonic as valMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { base64 } from '@scure/base';
import type { NetworkName } from '@arkade-os/sdk';

/**
 * At-rest keystore crypto. Pure crypto + encoding only — NO
 * `chrome.*` here so it round-trips under plain WebCrypto in vitest. The lock model
 * (SW-memory seed, auto-lock) lives in `keystore.ts`; the typed storage I/O in
 * `storage.ts`.
 *
 * Cipher: AES-256-GCM, fresh random 12-byte IV per write, auth tag verified on
 * decrypt (we NEVER return unauthenticated plaintext — a tampered blob throws).
 * `additionalData = "arkade-vault-v1" + network` binds the ciphertext to its network
 * so a vault can't be silently replayed under a different operator.
 */

// ─── Mnemonic (BIP39, English) ───────────────────────────────────────────────

/** Generate a fresh BIP39 mnemonic via @scure/bip39's CSPRNG. 128 bits = 12 words, 256 = 24. */
export function generateMnemonic(strength: 128 | 256 = 128): string {
  return genMnemonic(wordlist, strength);
}

/** Validate an imported mnemonic (checksum + wordlist) before we ever derive from it. */
export function validateMnemonic(mnemonic: string): boolean {
  return valMnemonic(mnemonic, wordlist);
}

// ─── Vault format ────────────────────────────────────────────────────────────

export const VAULT_VERSION = 1 as const;
export const AAD_PREFIX = 'arkade-vault-v1';

/**
 * KDF discriminator. PBKDF2 is the de-facto primary for now (ponytail decision below);
 * the field exists so an `argon2id` variant can be added later WITHOUT breaking existing
 * vaults — decrypt switches on `kdf`, so old blobs keep decrypting under PBKDF2.
 */
export type Kdf = 'pbkdf2';

export interface Pbkdf2Params {
  hash: 'SHA-256';
  iterations: number;
}

/** Encrypted blob persisted to chrome.storage.local. All binary fields are base64. */
export interface VaultBlob {
  v: typeof VAULT_VERSION;
  kdf: Kdf;
  kdfParams: Pbkdf2Params;
  salt: string; // base64, 16 bytes
  iv: string; // base64, 12 bytes
  ct: string; // base64, AES-GCM ciphertext incl. 16-byte auth tag
}

// ponytail: KDF = PBKDF2-HMAC-SHA-256 @ 600k iters (pure WebCrypto, runs under
// `script-src 'self'`). The preferred Argon2id needs a WASM lib, which won't
// instantiate under the current MV3 CSP (no 'wasm-unsafe-eval') — that's the open
// FLAG. Upgrade path: add `kdf:'argon2id'` + its params to the union and a branch
// in `deriveKey`; this PBKDF2 path stays for old vaults.
export const PBKDF2_ITERATIONS = 600_000;

const SALT_BYTES = 16;
const IV_BYTES = 12;
const enc = new TextEncoder();

/**
 * Copy bytes into a fresh `ArrayBuffer`-backed Uint8Array. `@scure/base` and
 * `TextEncoder` hand back `Uint8Array<ArrayBufferLike>`, which TS 5.7+ won't accept
 * as WebCrypto's `BufferSource` (it could be SharedArrayBuffer-backed). The copy is
 * tiny (salt/iv/AAD/mnemonic) and keeps the WebCrypto calls strictly typed.
 */
function toBuf(u: Uint8Array): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(u) as Uint8Array<ArrayBuffer>;
}

function additionalData(network: NetworkName): Uint8Array<ArrayBuffer> {
  return toBuf(enc.encode(AAD_PREFIX + network));
}

/**
 * Derive the AES-256-GCM key from the password via PBKDF2-HMAC-SHA-256.
 * `extractable: false` — the raw key bytes can never leave WebCrypto, and the key
 * is never persisted (only the salt is). Returns a non-extractable CryptoKey.
 */
async function deriveKey(password: string, salt: Uint8Array, params: Pbkdf2Params): Promise<CryptoKey> {
  const passwordKey = await crypto.subtle.importKey('raw', toBuf(enc.encode(password)), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: toBuf(salt), iterations: params.iterations, hash: params.hash },
    passwordKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// ─── Encrypt / decrypt ───────────────────────────────────────────────────────

/**
 * Encrypt a mnemonic under `password`, bound to `network`. Fresh random salt + IV
 * every call — re-encrypting the same mnemonic yields a different IV and ciphertext.
 */
export async function encryptVault(
  mnemonic: string,
  password: string,
  network: NetworkName,
): Promise<VaultBlob> {
  if (!password) throw new Error('encryptVault: empty password');
  if (!validateMnemonic(mnemonic)) throw new Error('encryptVault: invalid mnemonic');

  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const kdfParams: Pbkdf2Params = { hash: 'SHA-256', iterations: PBKDF2_ITERATIONS };
  const key = await deriveKey(password, salt, kdfParams);

  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: additionalData(network) },
      key,
      toBuf(enc.encode(mnemonic)),
    ),
  );

  return {
    v: VAULT_VERSION,
    kdf: 'pbkdf2',
    kdfParams,
    salt: base64.encode(salt),
    iv: base64.encode(iv),
    ct: base64.encode(ct),
  };
}

/**
 * Decrypt a vault. Throws on a wrong password, tampered ciphertext/IV/salt, or a
 * network mismatch — AES-GCM auth-tag verification fails closed, so we never hand
 * back unauthenticated plaintext. Callers MUST treat any throw as "do not trust".
 */
export async function decryptVault(
  blob: VaultBlob,
  password: string,
  network: NetworkName,
): Promise<string> {
  if (blob.v !== VAULT_VERSION) throw new Error(`decryptVault: unsupported version ${blob.v}`);
  if (blob.kdf !== 'pbkdf2') throw new Error(`decryptVault: unsupported kdf ${blob.kdf}`);

  // Downgrade defense: the blob lives in chrome.storage.local, so an attacker who
  // can rewrite it could drop `iterations` to 1 (or weaken the hash) to make an
  // offline brute-force against the real salt/ct far cheaper. Reject params below
  // our floor. Same uniform error as auth failure — no new distinguishing oracle.
  if (blob.kdfParams.iterations < PBKDF2_ITERATIONS || blob.kdfParams.hash !== 'SHA-256') {
    throw new Error('decryptVault: authentication failed');
  }

  const salt = base64.decode(blob.salt);
  const iv = base64.decode(blob.iv);
  const ct = base64.decode(blob.ct);
  const key = await deriveKey(password, salt, blob.kdfParams);

  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toBuf(iv), additionalData: additionalData(network) },
      key,
      toBuf(ct),
    );
  } catch {
    // WebCrypto throws a generic OperationError on auth-tag failure; normalize it
    // and reveal nothing about why (wrong password vs. tamper vs. wrong network).
    throw new Error('decryptVault: authentication failed');
  }

  const mnemonic = new TextDecoder().decode(plaintext);
  // Defense in depth: a valid GCM tag already guarantees integrity, but if the
  // decoded bytes somehow aren't a valid mnemonic, refuse rather than derive.
  if (!validateMnemonic(mnemonic)) throw new Error('decryptVault: decrypted payload is not a valid mnemonic');
  return mnemonic;
}

/** BIP39 mnemonic -> 64-byte seed. Used by `buildWallet`; kept here beside derivation. */
export function mnemonicToSeed(mnemonic: string): Uint8Array {
  return mnemonicToSeedSync(mnemonic);
}
