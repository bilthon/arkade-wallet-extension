import { sendMessage } from '@/src/messaging';
import type { NetworkName } from '@arkade-os/sdk';

/**
 * Thin popup → background client. Every call is a typed `sendMessage` to the SW
 * (the only place the seed/wallet live). The popup itself holds no secrets and
 * builds no wallet — it renders results.
 */
export const client = {
  hasVault: () => sendMessage('hasVault', undefined),
  getLockState: () => sendMessage('getLockState', undefined),
  createWallet: (password: string, strength?: 128 | 256) =>
    sendMessage('createWallet', { password, strength }),
  importWallet: (mnemonic: string, password: string) =>
    sendMessage('importWallet', { mnemonic, password }),
  unlock: (password: string) => sendMessage('unlock', { password }),
  lock: () => sendMessage('lock', undefined),
  getMnemonicForBackup: (password: string) =>
    sendMessage('getMnemonicForBackup', { password }),
  switchNetwork: (network: NetworkName, password: string) =>
    sendMessage('switchNetwork', { network, password }),
  getNetwork: () => sendMessage('getNetwork', undefined),
  getWalletSnapshot: () => sendMessage('getWalletSnapshot', undefined),
  refreshWalletSnapshot: () => sendMessage('refreshWalletSnapshot', undefined),
  send: (address: string, amount: number) =>
    sendMessage('send', { address, amount }),
  renewNow: () => sendMessage('renewNow', undefined),
  recoverNow: () => sendMessage('recoverNow', undefined),
  onboardNow: () => sendMessage('onboardNow', undefined),
  getRenewalWarning: () => sendMessage('getRenewalWarning', undefined),
  // Connected sites (Track E2a): list + revoke per-origin web app grants.
  listConnectedSites: () => sendMessage('listConnectedSites', undefined),
  revokeConnectedSite: (origin: string) =>
    sendMessage('revokeConnectedSite', { origin }),
};

/** True when a read failed because the wallet is locked (SW threw 'LOCKED'). */
export function isLockedError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('LOCKED');
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
