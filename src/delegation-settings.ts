import { hex } from '@scure/base';
import type { ExtendedVirtualCoin } from '@arkade-os/sdk';
import { catchUpDelegation } from './delegation-maintenance';
import { assertOperatorFeesZero } from './delegation-policy';
import { validateDelegateAddress } from './delegation-provider';
import { configureDelegation } from './delegation-session';
import {
  getDelegationConfig, getDelegationSubmissions,
  type ApprovedDelegate, type DelegationConfig, type DelegationScope, type DelegationSubmission,
} from './delegation-state';
import { createDelegateTransport } from './delegation-transport';
import { networkConfig } from './wallet';
import type { SessionContext } from './wallet-runtime';
import { ownedContractScript, delegateCompatibleScripts } from './wallet-scripts';

/**
 * Connect the popup's delegation controls to the background wallet. This file reads
 * status, prepares delegate approvals, and handles pause, resume, and retry actions.
 * The session module applies configuration changes; maintenance submits outstanding
 * authorizations. Transaction building and automatic renewal live elsewhere.
 * Only public settings and results are returned to the popup, never signing keys.
 */
export interface DelegationSettings {
  sessionId: string;
  available: boolean;
  endpoint: string;
  config: DelegationConfig | null;
  /** Saved status for each exact outpoint; replacement coins have their own status. */
  coins: Record<string, CoinDelegationInfo>;
  summary: {
    delegated: number;
    pending: number;
    failed: number;
    notConfigured: number;
    /** All ordinary, unspent, sats-only wallet VTXOs, including those needing migration. */
    totalSats: number;
    lastError: string | null;
  };
}

/** Public status details for the popup; never include signed authorizations. */
export type CoinDelegationInfo =
  | { status: 'delegated'; submittedAt: number }
  | { status: 'pending' }
  | { status: 'failed'; attemptedAt: number; error: string }
  | { status: 'not-configured'; reason: string };

export interface DelegateApproval {
  reviewId: string;
  delegate: ApprovedDelegate;
}

// A new wallet gets a new random ID, so an old popup cannot change its settings.
// Pending approvals also belong to the wallet that fetched their terms.
const sessionIds = new WeakMap<SessionContext['wallet'], string>();
const pendingApprovals = new WeakMap<SessionContext['wallet'], DelegateApproval>();

/**
 * Load the saved configuration and recorded submission results for the settings screen.
 * This does not contact Fulmine, so its outage does not prevent viewing or pausing delegation.
 */
export async function getDelegationSettings(context: SessionContext): Promise<DelegationSettings> {
  context.assertCurrent();
  if (context.network !== 'regtest') {
    const summary: DelegationSettings['summary'] = {
      delegated: 0, pending: 0, failed: 0, notConfigured: 0, totalSats: 0, lastError: null,
    };
    return { available: false, sessionId: '', endpoint: '', config: null, coins: {}, summary };
  }
  const scope = await delegationScope(context);
  const config = await getDelegationConfig(scope);
  const { coins, ordinaryScripts } = await readDelegationCoins(context);
  const destination = await context.wallet.getAddress();
  const records = await getDelegationSubmissions(scope, coins.map((coin) => `${coin.txid}:${coin.vout}`));
  const compatibleScripts = config
    ? await delegateCompatibleScripts(context.wallet, scope.walletPublicKey, config.delegate.pubkey)
    : new Set<string>();
  const byOutpoint = new Map(records.map((record) => [record.outpoint, record]));
  const statuses: Record<string, CoinDelegationInfo> = {};
  for (const coin of coins) {
    const outpoint = `${coin.txid}:${coin.vout}`;
    statuses[outpoint] = classifyDelegation({
      coin, record: byOutpoint.get(outpoint), config, destination, compatibleScripts, ordinaryScripts,
    });
  }
  const ordinaryCoins = coins.filter((coin) => isOrdinaryCoin(coin, ordinaryScripts));
  const summary = summarizeDelegation(ordinaryCoins, statuses);
  context.assertCurrent();
  return {
    sessionId: getOrCreateSessionId(context), available: true,
    endpoint: networkConfig(context.network).delegateUrl ?? '', config, coins: statuses, summary,
  };
}

/**
 * Fetch and check the delegate's terms for the user to review. Keep a copy in memory
 * so approval can refer to exactly what was shown. Nothing is enabled or written to
 * saved configuration until the user approves.
 */
export async function previewDelegate(context: SessionContext): Promise<DelegateApproval> {
  context.assertCurrent();
  if (context.network !== 'regtest') throw new Error('Delegation is available on regtest only.');
  const url = networkConfig(context.network).delegateUrl;
  if (!url) throw new Error('No delegate endpoint is configured.');
  let info;
  try {
    info = await createDelegateTransport(url).getDelegateInfo();
  } catch {
    context.assertCurrent();
    throw new Error('Could not reach the delegate. Check the endpoint and try again.');
  }
  if (info.fee !== '0') throw new Error('Only zero-fee delegation is supported.');
  const delegate: ApprovedDelegate = { url, pubkey: info.pubkey, delegateAddress: info.delegateAddress, fee: '0' };
  if (!/^(02|03)[0-9a-f]{64}$/i.test(delegate.pubkey)) throw new Error('Invalid delegate public key.');
  validateDelegateAddress({ enabled: true, delegate }, context.wallet);
  try {
    await assertOperatorFeesZero(context.wallet, context.assertCurrent);
  } catch {
    context.assertCurrent();
    throw new Error('Could not confirm zero operator fees. Check the operator and try again.');
  }
  const approval = { reviewId: crypto.randomUUID(), delegate };
  pendingApprovals.set(context.wallet, approval);
  return structuredClone(approval);
}

/**
 * Approve the stored review. Configuration checks the terms with the delegate again
 * before saving them and rebuilding the wallet with delegation enabled.
 */
export async function approveDelegate(context: SessionContext, reviewId: string): Promise<void> {
  context.assertCurrent();
  const reviewed = pendingApprovals.get(context.wallet);
  if (!reviewed || reviewed.reviewId !== reviewId) {
    throw new Error('Approval expired. Review the delegate again.');
  }
  // Use the terms we kept when preparing the review. Remove it before proceeding
  // so the same approval cannot be used twice, even if configuration fails.
  pendingApprovals.delete(context.wallet);
  try {
    await configureDelegation(context, { enabled: true, delegate: reviewed.delegate });
  } catch (error) {
    if (error instanceof Error && error.message === 'LOCKED') throw error;
    throw new Error('Could not enable delegation. Review the current terms and try again.');
  }
}

/**
 * Pause or resume the existing approval. Pausing keeps the receiving address and
 * cannot revoke authorizations already sent. Resuming checks the approved terms again.
 */
export async function setDelegationEnabled(context: SessionContext, expectedSessionId: string, enabled: boolean): Promise<void> {
  assertSettingsSession(context, expectedSessionId);
  const config = await getDelegationConfig(await delegationScope(context));
  if (!config) throw new Error('Review and approve a delegate first.');
  try {
    await configureDelegation(context, { ...config, enabled });
  } catch (error) {
    if (error instanceof Error && error.message === 'LOCKED') throw error;
    throw new Error('Could not change delegation. Refresh settings and try again.');
  }
}

/**
 * Ask maintenance to submit outstanding authorizations, not to repeat a fund transfer.
 * It still skips accepted coins and respects the delay between failed attempts.
 */
export async function retryDelegation(context: SessionContext, expectedSessionId: string): Promise<void> {
  assertSettingsSession(context, expectedSessionId);
  const config = await getDelegationConfig(await delegationScope(context));
  if (!config?.enabled) throw new Error('Resume delegation before retrying.');
  context.assertCurrent();
  try {
    await catchUpDelegation(context.wallet);
  } catch {
    context.assertCurrent();
    throw new Error('Delegation could not finish. The wallet will retry while unlocked.');
  }
}

/**
 * Describe saved outcomes before considering today's configuration. Pausing or changing
 * the delegate cannot revoke an accepted authorization. A failure, however, describes
 * only the delegate and destination used for that attempt.
 */
function classifyDelegation({ coin, record, config, destination, compatibleScripts, ordinaryScripts }: {
  coin: ExtendedVirtualCoin;
  record: DelegationSubmission | undefined;
  config: DelegationConfig | null;
  destination: string;
  compatibleScripts: Set<string>;
  ordinaryScripts: Set<string>;
}): CoinDelegationInfo {
  if (record?.status === 'delegated') {
    return { status: 'delegated', submittedAt: record.submittedAt };
  }
  if (coin.assets?.length) {
    return { status: 'not-configured', reason: 'Coins containing assets are not supported by delegation yet.' };
  }
  if (!ordinaryScripts.has(coin.script.toLowerCase())) {
    return { status: 'not-configured', reason: 'This contract is not supported by wallet delegation.' };
  }
  if (!config) return { status: 'not-configured', reason: 'No delegate has been approved.' };
  if (!config.enabled) return { status: 'not-configured', reason: 'Delegation is paused.' };
  if (!compatibleScripts.has(coin.script.toLowerCase())) {
    return { status: 'not-configured', reason: 'This coin needs migration to the approved delegate’s receiving script.' };
  }
  if (record?.status === 'failed' && record.delegateUrl === config.delegate.url
    && record.delegatePubkey === config.delegate.pubkey && record.destination === destination) {
    return { status: 'failed', attemptedAt: record.attemptedAt, error: record.error };
  }
  return { status: 'pending' };
}

/** Count ordinary Bitcoin coins using the same statuses shown in coin control. */
function summarizeDelegation(
  coins: ExtendedVirtualCoin[], statuses: Record<string, CoinDelegationInfo>,
): DelegationSettings['summary'] {
  const summary: DelegationSettings['summary'] = {
    delegated: 0, pending: 0, failed: 0, notConfigured: 0, totalSats: 0, lastError: null,
  };
  let latestFailureAt = -1;
  for (const coin of coins) {
    summary.totalSats += coin.value;
    const info = statuses[`${coin.txid}:${coin.vout}`];
    if (info.status === 'not-configured') summary.notConfigured++;
    else summary[info.status]++;
    if (info.status === 'failed' && info.attemptedAt > latestFailureAt) {
      summary.lastError = info.error;
      latestFailureAt = info.attemptedAt;
    }
  }
  return summary;
}

/** Reuse the ID until this wallet is replaced, for example after locking or changing settings. */
function getOrCreateSessionId(context: SessionContext): string {
  let id = sessionIds.get(context.wallet);
  if (!id) {
    id = crypto.randomUUID();
    sessionIds.set(context.wallet, id);
  }
  return id;
}

/** Reject actions from a settings screen opened for a different wallet session. */
function assertSettingsSession(context: SessionContext, expectedSessionId: string): void {
  context.assertCurrent();
  if (context.network !== 'regtest') throw new Error('Delegation is available on regtest only.');
  if (sessionIds.get(context.wallet) !== expectedSessionId) throw new Error('Wallet changed. Reopen delegation settings.');
}

/** Identify which wallet, network, and operator the saved delegation records belong to. */
export async function delegationScope(context: SessionContext): Promise<DelegationScope> {
  return {
    walletPublicKey: hex.encode(await context.wallet.identity.xOnlyPublicKey()),
    network: context.network,
    operatorUrl: networkConfig(context.network).arkServerUrl,
  };
}

/**
 * Read this wallet's ordinary Bitcoin coins, excluding custom contracts and assets.
 * Verify their stored scripts before counting them as ours. Include expired and
 * recoverable coins in the totals; migration applies its own spendability checks.
 */
export async function ordinaryDelegationCoins(context: SessionContext): Promise<ExtendedVirtualCoin[]> {
  const { coins, ordinaryScripts } = await readDelegationCoins(context);
  return coins.filter((coin) => isOrdinaryCoin(coin, ordinaryScripts));
}

/** Read once so coin details and the ordinary-funds summary describe the same snapshot. */
async function readDelegationCoins(context: SessionContext): Promise<{
  coins: ExtendedVirtualCoin[];
  ordinaryScripts: Set<string>;
}> {
  const ownKey = hex.encode(await context.wallet.identity.xOnlyPublicKey());
  const manager = await context.wallet.getContractManager();
  const contracts = await manager.getContracts({ type: ['default', 'delegate'] });
  const scripts = new Set(contracts.flatMap((contract) => {
    const script = ownedContractScript(contract, ownKey);
    return script ? [hex.encode(script)] : [];
  }));
  const coins = await context.wallet.getVtxos({ withRecoverable: true });
  return {
    coins: coins.filter((coin) => !coin.isSpent && !coin.spentBy && !coin.isUnrolled),
    ordinaryScripts: scripts,
  };
}

function isOrdinaryCoin(coin: ExtendedVirtualCoin, scripts: Set<string>): boolean {
  return scripts.has(coin.script.toLowerCase()) && !coin.assets?.length;
}
