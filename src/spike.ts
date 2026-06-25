import {
  Wallet,
  MnemonicIdentity,
  IndexedDBWalletRepository,
  IndexedDBContractRepository,
} from '@arkade-os/sdk';

/**
 * G0 spike (PLAN.md §2, BUILD_PLAN §C/Phase-0 GATE G0).
 *
 * The single most important de-risk of the project: prove that the SDK's `Wallet`
 * — built for a PWA page service-worker — actually runs inside an MV3 *extension*
 * background service worker. We construct `Wallet.create({...})` backed by IndexedDB
 * repositories, fetch a balance, and attempt one real `settle()` against local nigiri
 * arkd. We report exactly what happened at each stage; we do NOT assert success.
 *
 * Honesty rule (team-lead): never fake a stage result. A `settle()` that throws
 * "nothing to settle" on an unfunded regtest wallet is a *real, recorded* outcome —
 * it still proves Wallet.create + provider reachability work in the SW.
 */

// Well-known BIP39 test vector — funds on it are throwaway. Never use for real money.
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

// nigiri arkd operator (PLAN.md §4). Override via the message payload to hit Mutinynet.
const DEFAULT_ARK_SERVER_URL = 'http://localhost:7070';

export type StageStatus = 'ok' | 'error' | 'skipped';

export interface StageResult {
  stage: string;
  status: StageStatus;
  detail?: string;
}

export interface G0SpikeResult {
  arkServerUrl: string;
  startedAt: number;
  finishedAt: number;
  stages: StageResult[];
  /** True only if Wallet.create + getBalance both succeeded (settle may legitimately have nothing to do). */
  walletUsableInSW: boolean;
}

function describe(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

/**
 * Runs the spike. Triggered from the background SW (via `runG0Spike` message) so
 * it executes in the exact context we need to validate. Logs each stage to the SW
 * console with an `[arkade:G0]` prefix and returns the structured result.
 */
export async function runG0Spike(
  arkServerUrl: string = DEFAULT_ARK_SERVER_URL,
): Promise<G0SpikeResult> {
  const stages: StageResult[] = [];
  const startedAt = Date.now();
  const log = (s: StageResult) => {
    stages.push(s);
    const line = `[arkade:G0] ${s.stage}: ${s.status}${s.detail ? ` — ${s.detail}` : ''}`;
    if (s.status === 'error') console.error(line);
    else console.log(line);
  };

  let wallet: Wallet | undefined;
  let walletCreated = false;
  let balanceOk = false;

  // Stage 1 — Wallet.create inside the MV3 background SW, IndexedDB-backed.
  try {
    const identity = MnemonicIdentity.fromMnemonic(TEST_MNEMONIC);
    wallet = await Wallet.create({
      identity,
      // arkServerUrl is @deprecated in favor of an explicit arkProvider, but PLAN.md §2/§4
      // and the Phase-0 spec call it out by name; it still resolves to a RestArkProvider.
      arkServerUrl,
      storage: {
        walletRepository: new IndexedDBWalletRepository(),
        contractRepository: new IndexedDBContractRepository(),
      },
    });
    walletCreated = true;
    log({ stage: 'Wallet.create', status: 'ok' });
  } catch (err) {
    log({ stage: 'Wallet.create', status: 'error', detail: describe(err) });
  }

  // Stage 2 — fetch a balance (proves operator reachability + IndexedDB read/write).
  if (wallet) {
    try {
      const balance = await wallet.getBalance();
      balanceOk = true;
      log({
        stage: 'getBalance',
        status: 'ok',
        detail: `available=${balance.available} settled=${balance.settled} preconfirmed=${balance.preconfirmed} boarding=${balance.boarding.total} total=${balance.total}`,
      });
    } catch (err) {
      log({ stage: 'getBalance', status: 'error', detail: describe(err) });
    }
  } else {
    log({ stage: 'getBalance', status: 'skipped', detail: 'no wallet' });
  }

  // Stage 3 — one real settle() against arkd. On an unfunded regtest wallet this
  // commonly throws "nothing to settle"; that is a recorded, honest outcome that
  // still proves the MuSig2 batch path is reachable from the SW. With funds, it
  // exercises the full multi-round SignerSession / tree-signing flow (Open Q#4).
  if (wallet) {
    try {
      const txid = await wallet.settle(undefined, (event) => {
        console.log(`[arkade:G0] settle event: ${event.type}`);
      });
      log({ stage: 'settle', status: 'ok', detail: `txid=${txid}` });
    } catch (err) {
      // Distinguish "no funds to settle" from a genuine SW/SDK failure in the detail.
      log({ stage: 'settle', status: 'error', detail: describe(err) });
    }
  } else {
    log({ stage: 'settle', status: 'skipped', detail: 'no wallet' });
  }

  const result: G0SpikeResult = {
    arkServerUrl,
    startedAt,
    finishedAt: Date.now(),
    stages,
    walletUsableInSW: walletCreated && balanceOk,
  };
  console.log('[arkade:G0] result', JSON.stringify(result, null, 2));
  return result;
}
