import { isExpired, isRecoverable, type ExtendedVirtualCoin, type VirtualCoin } from '@arkade-os/sdk';
import { catchUpDelegation } from './delegation-maintenance';
import { assertOperatorFeesZero } from './delegation-policy';
import { createSessionDelegate, validateDelegateAddress } from './delegation-provider';
import { delegationScope, ordinaryDelegationCoins } from './delegation-settings';
import { getDelegationConfig, getDelegationSubmissions, type DelegationConfig } from './delegation-state';
import { delegateCompatibleScripts } from './wallet-scripts';
import type { SessionContext } from './wallet-runtime';

/**
 * Move remaining ordinary Bitcoin funds to this wallet's delegation address after
 * the user reviews the exact coins, amount, and destination. Approving a delegate
 * and choosing to move these funds are separate decisions.
 *
 * After the transfer, ask maintenance to delegate the new coin. A failed delegation
 * request does not undo the transfer; it can be retried without moving funds again.
 */
export interface DelegationMigrationReview {
  reviewId: string;
  inputs: { txid: string; vout: number; value: number }[];
  amountSats: number;
  destination: string;
  feeSats: 0;
}

export interface DelegationMigrationResult {
  txid: string;
  /** The transfer succeeded, but acceptance by Fulmine is a separate, retryable step. */
  delegationPending: boolean;
}

interface Migration {
  review: DelegationMigrationReview;
  // Repeated confirmations share this promise, including its success or failure.
  result?: Promise<DelegationMigrationResult>;
  // Prevent a new review while the transfer and its delegation follow-up are running.
  running?: boolean;
}
// Reviews belong to the wallet that prepared them. A replacement wallet needs a new review.
const migrations = new WeakMap<SessionContext['wallet'], Migration>();

/**
 * Review an immediate self-transfer separately from approval. Ordinary renewal or
 * spending change may also move funds to the new receiving script over time.
 */
export async function prepareDelegationMigration(context: SessionContext): Promise<DelegationMigrationReview> {
  const config = await requireEnabledDelegation(context);
  const previous = migrations.get(context.wallet);
  const previousResult = previous?.result;
  if (previous?.running) {
    throw new Error('A migration is still running. Wait for it to finish before reviewing again.');
  }
  // The SDK cache can still contain spent coins after a lost send response. Ask the
  // indexer which candidates remain available instead of remembering earlier inputs.
  const candidates = await getMigrationCandidates(context, config);
  const coins = await filterAvailableCoins(context, candidates);
  const amountSats = coins.reduce((sum, coin) => sum + coin.value, 0);
  if (!coins.length) throw new Error('No ordinary funds need moving.');
  if (!Number.isSafeInteger(amountSats) || BigInt(amountSats) < context.wallet.dustAmount) {
    throw new Error('The selected funds are below the minimum delegation amount.');
  }
  const review: DelegationMigrationReview = {
    reviewId: crypto.randomUUID(),
    inputs: coins.map(({ txid, vout, value }) => ({ txid, vout, value })),
    amountSats, destination: await context.wallet.getAddress(), feeSats: 0,
  };
  context.assertCurrent();
  // Another review may have replaced the previous one while we read the coins.
  // Its result may also have appeared because the user confirmed it during those
  // reads. In either case, leave that operation in place.
  if (migrations.get(context.wallet) !== previous || previous?.result !== previousResult) {
    throw new Error('Another migration operation started. Finish it before reviewing again.');
  }
  migrations.set(context.wallet, { review });
  return structuredClone(review);
}

/**
 * Execute the exact reviewed inputs once. Repeated clicks share the same result,
 * including failures. Another attempt requires a fresh review of the remaining funds.
 * After a successful transfer, delegation failures are reported separately so Retry
 * delegation can authorize the new coin without moving the original funds again.
 */
export function executeDelegationMigration(context: SessionContext, reviewId: string): Promise<DelegationMigrationResult> {
  context.assertCurrent();
  const migration = migrations.get(context.wallet);
  if (!migration || migration.review.reviewId !== reviewId) {
    return Promise.reject(new Error('Migration review expired. Review existing funds again.'));
  }
  if (!migration.result) {
    migration.running = true;
    migration.result = moveReviewedFunds(context, migration.review).finally(() => {
      migration.running = false;
    });
  }
  return migration.result;
}

/** Recheck approval, destination, and inputs before sending the exact transfer the user reviewed. */
async function moveReviewedFunds(context: SessionContext, review: DelegationMigrationReview): Promise<DelegationMigrationResult> {
  const config = await requireEnabledDelegation(context);
  const checkedDelegate = createSessionDelegate(config, context.assertCurrent, undefined, {
    assertOperatorAllowed: () => assertOperatorFeesZero(context.wallet, context.assertCurrent),
  });
  try {
    await checkedDelegate.assertDelegationAllowed();
  } catch {
    context.assertCurrent();
    throw new Error('Could not confirm the approved delegation terms. Review delegation settings and try again.');
  }
  if (await context.wallet.getAddress() !== review.destination) {
    throw new Error('Receiving address changed. Review existing funds again.');
  }

  const selected = await revalidateReviewedInputs(context, review, config);
  context.assertCurrent();
  let txid: string;
  try {
    // SDK 0.4.39's explicit-input send returns the full selected value to this
    // address without a transfer fee. Its general send method chooses its own inputs.
    txid = await context.wallet.sendBitcoin({
      address: review.destination, amount: review.amountSats, selectedVtxos: selected,
    });
  } catch {
    throw new Error('The transfer was not confirmed. Check transaction history, then review the remaining funds.');
  }

  return requestDelegationAfterTransfer(context, txid, review.destination, config);
}

/**
 * The transfer has succeeded. Ask maintenance to submit outstanding authorizations,
 * then look for acceptance of this transfer's new coin. If the wallet locks, Fulmine
 * is unavailable, or acceptance is not recorded yet, keep the successful txid and
 * report delegation as pending. A later retry must not repeat the transfer.
 */
async function requestDelegationAfterTransfer(
  context: SessionContext, txid: string, destination: string, config: DelegationConfig,
): Promise<DelegationMigrationResult> {
  try {
    context.assertCurrent();
    await catchUpDelegation(context.wallet);
    // Sending the full input value to one address creates the new coin at output zero.
    // A missing acceptance record means we still need confirmation from the delegate.
    const [record] = await getDelegationSubmissions(await delegationScope(context), [`${txid}:0`]);
    const accepted = record?.status === 'delegated' && record.destination === destination
      && record.delegateUrl === config.delegate.url && record.delegatePubkey === config.delegate.pubkey;
    return { txid, delegationPending: !accepted };
  } catch {
    return { txid, delegationPending: true };
  }
}

/**
 * Find every reviewed coin in the wallet, then ask the indexer whether it is still
 * available. Reject the transfer if any input changed; never substitute other coins.
 */
async function revalidateReviewedInputs(
  context: SessionContext, review: DelegationMigrationReview, config: DelegationConfig,
): Promise<ExtendedVirtualCoin[]> {
  const candidates = await getMigrationCandidates(context, config);
  const available = new Map(candidates.map((coin) => [outpoint(coin), coin]));
  const selected: ExtendedVirtualCoin[] = [];
  for (const input of review.inputs) {
    const coin = available.get(outpoint(input));
    if (!coin || coin.value !== input.value) {
      throw new Error('Some reviewed coins changed. Refresh your wallet and review existing funds again.');
    }
    selected.push(coin);
  }
  if (!selected.length) throw new Error('No ordinary funds need moving.');
  const confirmed = await filterAvailableCoins(context, selected);
  if (confirmed.length !== selected.length) {
    throw new Error('Some reviewed coins changed. Refresh your wallet and review existing funds again.');
  }
  return confirmed;
}

/**
 * Keep only coins the indexer confirms are still available with the expected value
 * and script. Used before showing a review and again before signing it. Missing
 * coins are excluded. Keep the wallet's coin objects because they also contain the
 * script information needed to sign the transfer.
 */
async function filterAvailableCoins(
  context: SessionContext, coins: ExtendedVirtualCoin[],
): Promise<ExtendedVirtualCoin[]> {
  if (!coins.length) return [];
  let vtxos: VirtualCoin[];
  try {
    ({ vtxos } = await context.wallet.indexerProvider.getVtxos({
      outpoints: coins.map(({ txid, vout }) => ({ txid, vout })),
    }));
  } catch {
    throw new Error('Could not check the coins. Refresh your wallet and try again.');
  }
  const live = new Map(vtxos.map((coin) => [outpoint(coin), coin]));
  return coins.filter((coin) => {
    const confirmed = live.get(outpoint(coin));
    return confirmed && isSpendableSatsOnlyCoin(confirmed) && confirmed.value === coin.value
      && confirmed.script.toLowerCase() === coin.script.toLowerCase();
  });
}

function outpoint(coin: { txid: string; vout: number }): string {
  return `${coin.txid}:${coin.vout}`;
}

/** Exclude spent coins, exits, assets, and coins that need renewal or recovery first. */
function isSpendableSatsOnlyCoin(coin: VirtualCoin): boolean {
  return !coin.isSpent && !coin.spentBy && !coin.isUnrolled && !coin.assets?.length
    && !isExpired(coin) && !isRecoverable(coin);
}

/** Require an enabled approval whose delegate address matches this wallet's network and operator. */
async function requireEnabledDelegation(context: SessionContext): Promise<DelegationConfig> {
  context.assertCurrent();
  if (context.network !== 'regtest') throw new Error('Delegation is available on regtest only.');
  const config = await getDelegationConfig(await delegationScope(context));
  if (!config?.enabled) throw new Error('Enable delegation before moving existing funds.');
  validateDelegateAddress(config, context.wallet);
  return config;
}

/**
 * Find ordinary spendable coins that still need a delegation-compatible script.
 * Coins already usable by the approved delegate need authorization, not another move.
 * The indexer checks their current availability separately.
 */
async function getMigrationCandidates(context: SessionContext, config: DelegationConfig): Promise<ExtendedVirtualCoin[]> {
  const scope = await delegationScope(context);
  const compatibleScripts = await delegateCompatibleScripts(
    context.wallet, scope.walletPublicKey, config.delegate.pubkey,
  );
  const coins = await ordinaryDelegationCoins(context);
  return coins.filter((coin) => isSpendableSatsOnlyCoin(coin) && !compatibleScripts.has(coin.script.toLowerCase()));
}
