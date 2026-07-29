import type { Wallet } from '@arkade-os/sdk';
import { armAutoLock } from './auto-lock';
import { getSessionWallet, isUnlocked } from './wallet-runtime';

/** Acquire a wallet for a trusted popup action and extend the user's idle deadline. */
export async function getPopupWallet(): Promise<Wallet> {
  if (!isUnlocked()) throw new Error('LOCKED');
  await armAutoLock();
  return getSessionWallet();
}

/** Require a live session for popup work that acquires its wallet internally. */
export async function requirePopupSession(): Promise<void> {
  if (!isUnlocked()) throw new Error('LOCKED');
  await armAutoLock();
}

/**
 * Acquire a wallet for an untrusted provider request without extending auto-lock. A site
 * may use the session while the user keeps it open, but cannot decide how long it stays open.
 */
export function getProviderWallet(): Promise<Wallet> {
  return getSessionWallet();
}
