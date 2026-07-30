import { armAutoLock } from './auto-lock';
import { getSessionContext, isUnlocked, type SessionContext } from './wallet-runtime';

/** Acquire a session capability for a trusted popup action and extend the idle deadline. */
export async function getPopupContext(): Promise<SessionContext> {
  if (!isUnlocked()) throw new Error('LOCKED');
  await armAutoLock();
  return getSessionContext();
}

/**
 * Acquire a session capability for an untrusted provider request without extending
 * auto-lock. A site may use the session while the user keeps it open, but cannot decide
 * how long it stays open.
 */
export function getProviderContext(): Promise<SessionContext> {
  return getSessionContext();
}
