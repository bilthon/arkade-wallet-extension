import type { Wallet } from '@arkade-os/sdk';
import { hex } from '@scure/base';
import {
  listDelegationSubmissions, removeDelegationSubmission,
  type DelegationConfig, type DelegationScope,
} from './delegation-state';
import { installDelegationTracking } from './delegation-submissions';
import { startDelegationAutomation } from './delegation-automation';
import { ownedContractScript } from './wallet-scripts';

interface WalletDelegation {
  enabled: boolean;
  catchUp: () => Promise<void>;
}
// Each unlocked wallet has its own catch-up operation and automation state.
const sessions = new WeakMap<Wallet, WalletDelegation>();

/** The renewal alarm uses this to avoid running a second automatic settlement loop. */
export function hasDelegationAutomation(wallet: Wallet): boolean {
  return sessions.get(wallet)?.enabled ?? false;
}

/**
 * Catch up on delegation for this wallet: remove records for coins the indexer
 * confirms were spent or unrolled, then, if enabled, submit eligible coins still
 * needing delegation. Submission tracking skips accepted coins and applies retry delays.
 *
 * This does not query Fulmine for task status or renew coins directly.
 * The map holds the catch-up function installed for each wallet session;
 * simultaneous calls share the same in-progress operation. If this wallet has
 * no delegation session installed, there is nothing to do.
 */
export async function catchUpDelegation(wallet: Wallet): Promise<void> {
  await sessions.get(wallet)?.catchUp();
}

/**
 * Connect delegation to one wallet session. Install submission tracking first so
 * SDK receive events and catch-up requests share the same checks and records.
 * Then start automation if enabled, schedule an initial catch-up, and attach
 * shutdown to wallet disposal.
 *
 * Catch-up handles coins already present when the wallet opens and retries missed
 * submissions. It also removes records for coins confirmed spent or unrolled.
 * Paused sessions still clean up records, but do not authorize new delegation.
 */
export async function initializeWalletDelegation(
  wallet: Wallet,
  scope: DelegationScope,
  config: DelegationConfig,
  assertCurrent: () => void,
  checks: { assertSettlementAllowed: () => Promise<void>; assertDelegationAllowed: () => Promise<void> },
): Promise<void> {
  const manager = await wallet.getDelegateManager();
  if (!manager) throw new Error('Delegate manager is unavailable.');
  // Capture the checked manager so nested functions also know it is available.
  const delegateManager = manager;
  const submissions = installDelegationTracking(delegateManager, {
    scope, delegate: config.delegate, assertCurrent,
    eligibleScripts: getEligibleDelegationScripts,
    assertDelegationAllowed: checks.assertDelegationAllowed,
  });

  let stopped = false;
  let pending: Promise<void> | undefined;

  assertCurrent();
  const automation = config.enabled
    ? startDelegationAutomation(wallet, checks.assertSettlementAllowed, assertCurrent, submissions)
    : undefined;
  sessions.set(wallet, { enabled: config.enabled, catchUp });
  // Startup catches coins already in the repository, which need not emit receive events.
  const startup = setTimeout(() => {
    void catchUp().catch(() => { /* The maintenance alarm retries without extending auto-lock. */ });
  }, 0);
  // Stop new catch-up work and automation before disposing the SDK wallet.
  // Always dispose the wallet, even if stopping automation fails.
  const dispose = wallet.dispose.bind(wallet);
  wallet.dispose = async () => {
    stopped = true;
    clearTimeout(startup);
    sessions.delete(wallet);
    try {
      await automation?.stop();
    } finally {
      await dispose();
    }
  };

  /** Find ordinary wallet scripts that use the delegate approved for this session. */
  async function getEligibleDelegationScripts(): Promise<Set<string>> {
    const contractManager = await wallet.getContractManager();
    const contracts = await contractManager.getContracts({ type: ['delegate'] });
    // Stored scripts use an x-only key; approval stores the compressed public key.
    const delegateKey = config.delegate.pubkey.slice(2).toLowerCase();
    const scripts = new Set<string>();
    for (const contract of contracts) {
      if (contract.params?.delegatePubKey?.toLowerCase() !== delegateKey) continue;
      // A delegate key match alone does not prove that this wallet owns the script.
      const script = ownedContractScript(contract, scope.walletPublicKey);
      if (script) scripts.add(hex.encode(script));
    }
    return scripts;
  }

  /** Startup and alarm requests share any catch-up already running for this wallet. */
  function catchUp(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (pending) return pending;
    pending = catchUpOnce().finally(() => {
      pending = undefined;
    });
    return pending;
  }

  /** Clean up old records first, then submit outstanding coins if delegation is enabled. */
  async function catchUpOnce(): Promise<void> {
    assertCurrent();
    await removeObsoleteSubmissionRecords();
    if (config.enabled) {
      await delegateExistingCoins();
    }
  }

  /** Remove records only when the indexer confirms the coin was spent or unrolled. */
  async function removeObsoleteSubmissionRecords(): Promise<void> {
    // Old coins may have disappeared from the SDK cache. Ask about the recorded
    // outpoints directly, in batches of 50 to keep each request small. A missing
    // response is not proof of spend, so leave that record for a later check.
    const records = await listDelegationSubmissions(scope);
    for (let offset = 0; offset < records.length; offset += 50) {
      const batch = records.slice(offset, offset + 50);
      const requested = new Set(batch.map((record) => record.outpoint));
      const { vtxos } = await wallet.indexerProvider.getVtxos({
        outpoints: batch.map(({ outpoint }) => {
          const [txid, vout] = outpoint.split(':');
          return { txid, vout: Number(vout) };
        }),
      });
      assertCurrent();
      for (const coin of vtxos) {
        const key = `${coin.txid}:${coin.vout}`;
        if (requested.has(key) && (coin.isSpent || coin.spentBy || coin.isUnrolled)) {
          await removeDelegationSubmission(scope, key);
        }
      }
    }
  }

  /** Catch coins that need delegation even if no new receive event was emitted. */
  async function delegateExistingCoins(): Promise<void> {
    const contractManager = await wallet.getContractManager();
    const contracts = await contractManager.getContractsWithVtxos({ type: ['delegate'] });
    const destination = await wallet.getAddress();
    // The tracked manager checks the session when this work reaches its queue,
    // and handles SDK receive events, deduplication, and retries.
    await delegateManager.delegate(contracts.flatMap(({ vtxos }) => vtxos), destination);
  }
}
