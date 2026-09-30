import { VtxoManager, VtxoScript, isExpired, type ExtendedCoin, type ExtendedVirtualCoin, type IWallet, type Wallet } from '@arkade-os/sdk';
import { hex } from '@scure/base';
import type { DelegationSubmissions } from './delegation-submissions';
import { ownScriptsFor } from './wallet-scripts';

/** Accept recognized wallet coins without assets; skip scripts we cannot decode. */
function isOrdinaryCoin(coin: ExtendedCoin, scripts: Set<string>): boolean {
  // The SDK preserves assets, but this feature currently automates Bitcoin-only coins.
  if ('assets' in coin && Array.isArray(coin.assets) && coin.assets.length > 0) return false;
  try {
    return scripts.has(hex.encode(VtxoScript.decode(coin.tapTree).pkScript));
  } catch {
    return false;
  }
}

/** Distinguish Arkade VTXOs, which can expire, from on-chain boarding deposits. */
function isVirtualCoin(coin: ExtendedCoin): coin is ExtendedVirtualCoin {
  return 'virtualStatus' in coin;
}

/** Reject SDK interface operations that this automation does not use. */
async function unsupported(): Promise<never> {
  throw new Error('This operation is not available to delegation automation.');
}

/**
 * Start the wallet's background onboarding and renewal after delegation opt-in.
 * The caller installs delegation tracking first and calls this only when enabled.
 *
 * The SDK decides when to onboard deposits or renew VTXOs. We give it an adapter
 * over the existing wallet that limits which coins it sees. The SDK builds the
 * self-transfer; we enforce the approved fee policy and leave coins accepted by
 * Fulmine alone unless they expire. Manual wallet operations are unchanged.
 *
 * Startup creates that adapter, starts the SDK manager, and returns a stop function
 * for session cleanup. The helpers below implement coin selection and settlement
 * checks; they share this session's state without creating another signing identity.
 * None of this background work extends the wallet's auto-lock timer.
 */
export function startDelegationAutomation(
  wallet: Wallet,
  assertSettlementAllowed: () => Promise<void>,
  assertCurrent: () => void,
  submissions: DelegationSubmissions,
): { stop: () => Promise<void> } {
  let stopped = false;

  const automaticWallet = createAutomationWallet();
  assertRunning();
  const manager = new VtxoManager(automaticWallet, undefined, {
    // The adapter excludes accepted, unexpired coins. Use a one-hour
    // safety margin for ordinary/pending/failed coins, even during a Fulmine outage.
    vtxoThreshold: 60 * 60,
    pollIntervalMs: 60_000,
    boardingUtxoSweep: false,
    deprecatedSignerMigration: false,
  });

  return {
    stop: async () => {
      // Refuse further settlement immediately, then let the SDK finish cleanup.
      stopped = true;
      await manager.dispose();
    },
  };

  /** Refuse new work after this session ends or its automation is stopped. */
  function assertRunning() {
    assertCurrent();
    if (stopped) throw new Error('Delegation automation stopped.');
  }

  // Collect the scripts recognized as belonging to this wallet. A read may finish
  // after locking; settleAutomatically checks the session before spending anything.
  async function ownedScripts() {
    const publicKey = hex.encode(await wallet.identity.xOnlyPublicKey());
    return ownScriptsFor(wallet, publicKey);
  }

  /** Leave accepted coins to Fulmine, but allow online recovery if they expire. */
  async function excludeCoinsHandledByDelegate<T extends ExtendedCoin>(coins: T[]): Promise<T[]> {
    const destination = await wallet.getAddress();
    const accepted = await submissions.acceptedOutpoints(
      coins.map((coin) => `${coin.txid}:${coin.vout}`), destination,
    );
    return coins.filter((coin) => {
      // Acceptance is not proof of execution. If the coin expires despite delegation,
      // let the online wallet attempt renewal/recovery rather than skip it forever.
      if (isVirtualCoin(coin) && isExpired(coin)) return true;
      return !accepted.has(`${coin.txid}:${coin.vout}`);
    });
  }

  /** Give the SDK ordinary VTXOs it may renew; the SDK applies the expiry threshold. */
  async function getRenewableVtxos(filter?: Parameters<IWallet['getVtxos']>[0]) {
    assertRunning();
    const coins = await wallet.getVtxos(filter);
    const scripts = await ownedScripts();
    return excludeCoinsHandledByDelegate(coins.filter((coin) => isOrdinaryCoin(coin, scripts)));
  }

  /** Give the SDK ordinary on-chain deposits it may bring into Arkade. */
  async function getOnboardableDeposits() {
    assertRunning();
    const coins = await wallet.getBoardingUtxos();
    const scripts = await ownedScripts();
    return coins.filter((coin) => isOrdinaryCoin(coin, scripts));
  }

  /** Coordinate SDK settlement with delegation, fee approval, and session lifetime. */
  function settleAutomatically(
    params: Parameters<IWallet['settle']>[0],
    eventCallback?: Parameters<IWallet['settle']>[1],
  ) {
    // Fulmine may accept a coin after the SDK selects it. Share the submission queue
    // and recheck acceptance inside it, so delegation cannot race this settlement.
    return submissions.runExclusive(async () => {
      assertRunning();
      if (!params || params.inputs.length === 0) {
        throw new Error('Automatic settlement requires explicit inputs.');
      }
      // The SDK selects from our filtered reads and constructs the self-transfer.
      // Keep wallet-specific fee approval here rather than rebuilding its checks.
      await assertSettlementAllowed();
      const available = await excludeCoinsHandledByDelegate(params.inputs);
      if (available.length !== params.inputs.length) {
        throw new Error('A selected coin was delegated; automatic settlement will retry.');
      }
      // Session identity guards also fence the SDK's later signing steps.
      assertRunning();
      return wallet.settle(params, eventCallback);
    });
  }

  /** Connect our selection and settlement rules to the SDK's wallet interface. */
  function createAutomationWallet(): IWallet & Pick<Wallet,
    'boardingTapscript' | 'onchainProvider' | 'arkProvider' | 'network' | 'dustAmount'
  > & { signOnchainBoardingTx: typeof unsupported } {
    // The SDK checks for boarding sweep capabilities even with sweeps disabled.
    // Supply the required properties, but refuse on-chain sweep signing.
    return {
      identity: wallet.identity,
      get boardingTapscript() { return wallet.boardingTapscript; },
      onchainProvider: wallet.onchainProvider,
      arkProvider: wallet.arkProvider,
      network: wallet.network,
      dustAmount: wallet.dustAmount,
      signOnchainBoardingTx: unsupported,
      getAddress: () => wallet.getAddress(),
      getBoardingAddress: () => wallet.getBoardingAddress(),
      getBalance: () => wallet.getBalance(),
      getTransactionHistory: () => wallet.getTransactionHistory(),
      getContractManager: () => wallet.getContractManager(),
      getDelegateManager: () => wallet.getDelegateManager(),
      getDelegatorManager: () => wallet.getDelegateManager(),
      getVtxos: getRenewableVtxos,
      getBoardingUtxos: getOnboardableDeposits,
      settle: settleAutomatically,
      // Required by IWallet, but unused by the manager and unavailable to automation.
      send: unsupported,
      sendBitcoin: unsupported,
      assetManager: {
        getAssetDetails: (assetId) => wallet.assetManager.getAssetDetails(assetId),
        issue: unsupported,
        reissue: unsupported,
        burn: unsupported,
      },
    };
  }
}
