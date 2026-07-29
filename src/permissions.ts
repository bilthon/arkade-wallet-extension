/**
 * Per-origin scoped grants.
 *
 * A grant records what a single, SW-verified origin (see `origin.ts`) is allowed to do:
 *   { id, origin, accounts, grantedMethods, grantedAt }
 *
 * `connect` is the ONLY thing that creates a grant, and it grants READ methods only —
 * no signing/sending method is ever auto-granted here (those re-prompt per call, a
 * later PR). Subsequent read calls check the grant + wallet-unlocked; they do NOT
 * re-prompt. `disconnect()` / Settings → Connected sites revoke a grant immediately.
 *
 * Stored in `chrome.storage.local` (persistent, small key-value) keyed by origin.
 */

/**
 * The READ method set a `connect` grant authorizes. Intentionally narrow: addresses,
 * pubkey, balance, network, accounts. NO send/sign — those require a per-call approval.
 */
export const READ_METHODS = [
  'getAccounts',
  'getAddress',
  'getBoardingAddress',
  'getPublicKey',
  'getBalance',
  'getNetwork',
] as const;

export type GrantedMethod = (typeof READ_METHODS)[number];

export interface Grant {
  /** Unique issuance id used to make compensating revocation conditional. */
  id: string;
  /** SW-derived origin (the grant key). Never a site-supplied label. */
  origin: string;
  /** Arkade account address(es) the origin may see. Single-account for now. */
  accounts: string[];
  /** Methods this origin may call without re-prompting. */
  grantedMethods: GrantedMethod[];
  /** Epoch-ms the grant was created (shown in the Connected-sites UI). */
  grantedAt: number;
}

const GRANTS_KEY = 'grants';

type GrantMap = Record<string, Grant>;

let mutationTail: Promise<void> = Promise.resolve();

/** Serialize grant writes so compare-and-delete cannot race a newer grant. */
function mutateGrants<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationTail.then(operation, operation);
  mutationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function readAll(): Promise<GrantMap> {
  const got = await browser.storage.local.get(GRANTS_KEY);
  return (got[GRANTS_KEY] as GrantMap | undefined) ?? {};
}

async function writeAll(map: GrantMap): Promise<void> {
  await browser.storage.local.set({ [GRANTS_KEY]: map });
}

/** Every grant, newest-first — for the Connected-sites settings screen. */
export async function listGrants(): Promise<Grant[]> {
  const map = await readAll();
  return Object.values(map).sort((a, b) => b.grantedAt - a.grantedAt);
}

/** The grant for an origin, or null if the origin has never connected / was revoked. */
export async function getGrant(origin: string): Promise<Grant | null> {
  const map = await readAll();
  return map[origin] ?? null;
}

/**
 * Persist a read-only `connect` grant for an SW-verified origin. Always grants exactly
 * `READ_METHODS` — the caller cannot widen the scope to a signing method through here.
 * Overwrites any prior grant for the same origin (re-connect refreshes `accounts`).
 */
export async function grantConnect(origin: string, accounts: string[]): Promise<Grant> {
  return mutateGrants(async () => {
    const grant: Grant = {
      id: crypto.randomUUID(),
      origin,
      accounts,
      grantedMethods: [...READ_METHODS],
      grantedAt: Date.now(),
    };
    const map = await readAll();
    map[origin] = grant;
    await writeAll(map);
    return grant;
  });
}

/** Remove an origin's grant. Idempotent — revoking an unknown origin is a no-op. */
export async function revokeGrant(origin: string): Promise<void> {
  await mutateGrants(async () => {
    const map = await readAll();
    if (origin in map) {
      delete map[origin];
      await writeAll(map);
    }
  });
}

/** Remove exactly one grant issuance, preserving any newer reconnect. */
export function revokeGrantIfCurrent(origin: string, grantId: string): Promise<boolean> {
  return mutateGrants(async () => {
    const map = await readAll();
    if (map[origin]?.id !== grantId) return false;
    delete map[origin];
    await writeAll(map);
    return true;
  });
}

/** Whether an origin currently has any grant (i.e. is "connected"). */
export async function isConnected(origin: string): Promise<boolean> {
  return (await getGrant(origin)) !== null;
}

/**
 * Whether an origin is allowed to call `method`. True only when a grant exists AND the
 * method is in its `grantedMethods`. The gate every read handler runs before doing work.
 */
export async function isMethodGranted(origin: string, method: string): Promise<boolean> {
  const grant = await getGrant(origin);
  if (!grant) return false;
  return grant.grantedMethods.includes(method as GrantedMethod);
}
