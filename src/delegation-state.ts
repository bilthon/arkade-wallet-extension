import type { NetworkName } from '@arkade-os/sdk';

/**
 * Public delegation metadata in browser.storage.local, independent of SDK coin storage.
 * Approval describes future submissions; records describe authorizations already sent.
 * Pausing or replacing approval must therefore leave existing records intact.
 * This module stores state only: the runtime owns authorization and serialized transitions.
 */

/** Public identity and endpoint scope; never use a mnemonic or private key here. */
export interface DelegationScope {
  /** Wallet identity's x-only public key, encoded as hex. */
  walletPublicKey: string;
  network: NetworkName;
  operatorUrl: string;
}

export interface ApprovedDelegate {
  url: string;
  /** Compressed public key from the delegate's metadata. */
  pubkey: string;
  delegateAddress: string;
  fee: '0';
}

export interface DelegationConfig {
  delegate: ApprovedDelegate;
  /** False pauses new authorizations without revoking existing submissions. */
  enabled: boolean;
}

export type CoinDelegationStatus = 'delegated' | 'pending' | 'failed' | 'not-configured';

/** Persist outcomes only. Pending and not-configured are derived from live coins/config. */
export type DelegationSubmission = {
  /** Transaction ID and output index, separated by a colon. */
  outpoint: string;
  /** Endpoint used for this attempt, retained even if configuration changes. */
  delegateUrl: string;
  /** Delegate identity used for this attempt; compare with current approval when reconciling. */
  delegatePubkey: string;
  /** Wallet receiving address authorized for the renewed funds. */
  destination: string;
} & (
  | { status: 'delegated'; submittedAt: number }
  // error must be a controlled user-facing message, never a raw SDK error or response body.
  | { status: 'failed'; attemptedAt: number; error: string }
);

function scopeKey(scope: DelegationScope): string {
  // JSON keeps components unambiguous despite punctuation in URLs; v1 isolates the schema.
  return `delegation:v1:${JSON.stringify([
    scope.walletPublicKey, scope.network, scope.operatorUrl,
  ])}`;
}

function submissionKey(scope: DelegationScope, outpoint: string): string {
  return `${scopeKey(scope)}:submission:${outpoint}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPublicKey(value: unknown): value is string {
  return typeof value === 'string' && /^(02|03)[0-9a-f]{64}$/i.test(value);
}

/** Structural checks only; SDK integration must also verify addresses and live identity. */
function isConfig(value: unknown): value is DelegationConfig {
  if (!isObject(value) || typeof value.enabled !== 'boolean') return false;
  const delegate = value.delegate;
  return isObject(delegate) && isText(delegate.url) && isPublicKey(delegate.pubkey)
    && isText(delegate.delegateAddress) && delegate.fee === '0';
}

function isSubmission(value: unknown): value is DelegationSubmission {
  if (!isObject(value) || !isText(value.outpoint)
    || !/^[0-9a-f]{64}:\d+$/i.test(value.outpoint)
    || !isText(value.delegateUrl) || !isPublicKey(value.delegatePubkey)
    || !isText(value.destination)) return false;
  return value.status === 'delegated'
    ? isTimestamp(value.submittedAt)
    : value.status === 'failed' && isTimestamp(value.attemptedAt) && isText(value.error);
}

/** Missing or malformed approval fails closed: delegation is not enabled. */
export async function getDelegationConfig(scope: DelegationScope): Promise<DelegationConfig | null> {
  const key = `${scopeKey(scope)}:config`;
  const stored = await browser.storage.local.get(key);
  return isConfig(stored[key]) ? stored[key] : null;
}

/**
 * Replace an approval snapshot, not a read-modify-write transaction.
 * Callers must serialize config transitions in the background runtime; asynchronous
 * handlers can race even when they all live in the same service worker.
 */
export async function setDelegationConfig(
  scope: DelegationScope,
  config: DelegationConfig,
): Promise<void> {
  if (config?.delegate?.fee !== '0') throw new Error('Only zero-fee delegation is supported.');
  if (!isConfig(config)) throw new Error('Invalid delegation configuration.');
  const { url, pubkey, delegateAddress, fee } = config.delegate;
  await browser.storage.local.set({
    [`${scopeKey(scope)}:config`]: {
      enabled: config.enabled,
      delegate: { url, pubkey, delegateAddress, fee },
    },
  });
}

/** Read records for current coins without scanning unrelated wallet storage. */
export async function getDelegationSubmissions(
  scope: DelegationScope,
  outpoints: string[],
): Promise<DelegationSubmission[]> {
  const keys = outpoints.map((outpoint) => submissionKey(scope, outpoint));
  const stored = await browser.storage.local.get(keys);
  return keys.flatMap((key) => {
    const record: unknown = stored[key];
    return isSubmission(record) && submissionKey(scope, record.outpoint) === key ? [record] : [];
  });
}

/**
 * Maintenance-only scan: find records even when their coins have disappeared from the
 * SDK cache. Reconciliation can remove spent/replaced records without a second index
 * that would itself need atomic updates. Normal coin display uses the targeted read.
 */
export async function listDelegationSubmissions(scope: DelegationScope): Promise<DelegationSubmission[]> {
  const stored = await browser.storage.local.get(null);
  const prefix = `${scopeKey(scope)}:submission:`;
  return Object.entries(stored).flatMap(([key, record]) =>
    key.startsWith(prefix) && isSubmission(record) && submissionKey(scope, record.outpoint) === key
      ? [record] : [],
  );
}

export async function setDelegationSubmission(
  scope: DelegationScope,
  submission: DelegationSubmission,
): Promise<void> {
  if (!isSubmission(submission)) throw new Error('Invalid delegation submission.');
  const { outpoint, delegateUrl, delegatePubkey, destination } = submission;
  // Pick fields explicitly so SDK responses/PSBTs cannot be persisted by object spread.
  const record: DelegationSubmission = submission.status === 'delegated'
    ? { outpoint, delegateUrl, delegatePubkey, destination,
        status: 'delegated', submittedAt: submission.submittedAt }
    : { outpoint, delegateUrl, delegatePubkey, destination,
        status: 'failed', attemptedAt: submission.attemptedAt, error: submission.error };
  // Separate keys prevent concurrent submissions for different coins losing updates.
  await browser.storage.local.set({ [submissionKey(scope, outpoint)]: record });
}

export async function removeDelegationSubmission(
  scope: DelegationScope,
  outpoint: string,
): Promise<void> {
  await browser.storage.local.remove(submissionKey(scope, outpoint));
}
