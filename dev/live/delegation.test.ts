import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { expect, test, vi } from 'vitest';
import {
  InMemoryContractRepository, InMemoryWalletRepository, RestIndexerProvider,
  SingleKey, Wallet, type DelegateProvider,
} from '@arkade-os/sdk';
import { hex } from '@scure/base';
import { createDelegateTransport } from '../../src/delegation-transport';
import { createSessionDelegate, validateDelegateAddress } from '../../src/delegation-provider';
import { assertOperatorFeesZero, validateDelegationIntent } from '../../src/delegation-policy';
import { catchUpDelegation, initializeWalletDelegation } from '../../src/delegation-maintenance';
import { listDelegationSubmissions, setDelegationConfig, type DelegationConfig } from '../../src/delegation-state';
import { sessionIdentity } from '../../src/session-identity';
import { expiresAtMs } from '../../src/vtxo-state';

/** Poll real services without changing their clocks or shortening production timers. */
async function waitFor<T>(description: string, read: () => Promise<T | undefined>, timeoutMs = 180_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await read();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

function localEndpoint(name: string, fallback: string): string {
  const value = process.env[name] ?? fallback;
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error(`${name} must point to a local HTTP service.`);
  }
  return value.replace(/\/$/, '');
}

test.skipIf(process.env.LIVE_DELEGATION !== '1')('onboards, retries, and discovers an offline renewal', async () => {
  // Node lacks the browser EventSource API used by the SDK. Reuse a developer's
  // installed polyfill; this test does not add a runtime dependency to the wallet.
  const eventSourceModule = process.env.LIVE_EVENTSOURCE_MODULE;
  if (!eventSourceModule) throw new Error('Set LIVE_EVENTSOURCE_MODULE to an installed eventsource module.');
  const { EventSource } = await import(/* @vite-ignore */ pathToFileURL(eventSourceModule).href);
  vi.stubGlobal('EventSource', EventSource);

  const operatorUrl = localEndpoint('LIVE_ARK_URL', 'http://localhost:7071');
  const esploraUrl = localEndpoint('LIVE_ESPLORA_URL', 'http://localhost:30010');
  const delegateUrl = localEndpoint('LIVE_DELEGATE_URL', 'http://localhost:7012');
  const evidencePath = process.env.LIVE_EVIDENCE_PATH ?? '/tmp/delegation-live-results.json';
  const evidence: Array<Record<string, unknown>> = [];
  async function record(stage: string, details: Record<string, unknown> = {}) {
    const event = { stage, at: new Date().toISOString(), ...details };
    evidence.push(event);
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
    console.info(JSON.stringify(event));
  }

  // This private key exists only in this process. Only public addresses/outpoints
  // are recorded. Use disposable regtest funds: the key is discarded on exit.
  const identity = SingleKey.fromHex(hex.encode(crypto.getRandomValues(new Uint8Array(32))));
  const scope = { walletPublicKey: hex.encode(await identity.xOnlyPublicKey()), network: 'regtest' as const, operatorUrl };
  const stored: Record<string, unknown> = {};
  vi.stubGlobal('browser', { storage: { local: {
    get: async (keys: string | string[] | null) => structuredClone(keys === null ? stored
      : Object.fromEntries((typeof keys === 'string' ? [keys] : keys).map((key) => [key, stored[key]]))),
    set: async (values: Record<string, unknown>) => { Object.assign(stored, structuredClone(values)); },
    remove: async (keys: string | string[]) => {
      for (const key of typeof keys === 'string' ? [keys] : keys) delete stored[key];
    },
  } } });

  const remote = createDelegateTransport(delegateUrl);
  const info = await remote.getDelegateInfo();
  expect(info.fee).toBe('0');
  const config: DelegationConfig = { enabled: true, delegate: { ...info, url: delegateUrl, fee: '0' } };
  await setDelegationConfig(scope, config);
  let storage = {
    walletRepository: new InMemoryWalletRepository(),
    contractRepository: new InMemoryContractRepository(),
  };
  let simulateOutage = true;
  let submissions = 0;
  const transport: DelegateProvider = {
    getDelegateInfo: () => remote.getDelegateInfo(),
    delegate: async (...args) => {
      submissions++;
      // Fail only this wallet's request. Other users and Fulmine remain online.
      if (simulateOutage) throw new Error('Simulated connection failure.');
      return remote.delegate(...args);
    },
  };
  let session: { wallet: Wallet; close: () => Promise<void> } | undefined;

  /** Recreate the SDK wallet with real application policy, tracking, and automation. */
  async function openSession(automate = true) {
    let active = true;
    const assertCurrent = () => { if (!active) throw new Error('LOCKED'); };
    const delegate = createSessionDelegate(config, assertCurrent, transport, {
      assertOperatorAllowed: () => assertOperatorFeesZero(wallet, assertCurrent),
      validateIntent: async (intent) => validateDelegationIntent(intent, config.delegate, await wallet.getAddress()),
    });
    const wallet = await Wallet.create({
      identity: sessionIdentity(identity, assertCurrent),
      arkServerUrl: operatorUrl, esploraUrl, delegateProvider: delegate.provider,
      storage, settlementConfig: false,
    });
    const opened = { wallet, close: async () => { active = false; await wallet.dispose(); } };
    session = opened;
    validateDelegateAddress(config, wallet);
    if (automate) await initializeWalletDelegation(wallet, scope, config, assertCurrent, delegate);
    return opened;
  }

  try {
    let current = await openSession(false);
    // A localhost URL alone does not guarantee that the service uses test coins.
    expect((await current.wallet.arkProvider.getInfo()).network).toBe('regtest');
    await record('awaiting-funding', { boardingAddress: await current.wallet.getBoardingAddress(), amountSats: 100_000 });
    // The human/test coordinator funds this address and mines one ordinary block.
    // Funding is deliberately external: there are no node credentials in this test.
    await waitFor('boarding deposit before automation is enabled', async () => {
      const deposits = await current.wallet.getBoardingUtxos();
      return deposits.some((coin) => coin.status.confirmed) ? deposits : undefined;
    }, 300_000);
    expect((await current.wallet.getVtxos()).length).toBe(0);
    await record('deposit-awaits-automation');
    await current.close();
    current = await openSession();
    const original = await waitFor('automatic onboarding', async () => {
      const coins = await current.wallet.getVtxos();
      return coins.find((coin) => !coin.isSpent && !coin.spentBy);
    }, 300_000);
    expect(original.value).toBe(100_000);
    const oldOutpoint = `${original.txid}:${original.vout}`;
    await record('onboarded', { outpoint: oldOutpoint, value: original.value });

    const failure = await waitFor('recorded submission failure', async () => {
      await catchUpDelegation(current.wallet);
      return (await listDelegationSubmissions(scope)).find((item) => item.outpoint === oldOutpoint && item.status === 'failed');
    });
    expect(failure.status === 'failed' && failure.error).toBe('Delegation was not confirmed. The wallet will retry while unlocked.');
    const attemptsBeforeCooldown = submissions;
    await catchUpDelegation(current.wallet);
    expect(submissions).toBe(attemptsBeforeCooldown);
    await record('outage-recorded');
    simulateOutage = false;
    await waitFor('retry acceptance after the production cooldown', async () => {
      await catchUpDelegation(current.wallet);
      return (await listDelegationSubmissions(scope)).find((item) => item.outpoint === oldOutpoint && item.status === 'delegated');
    });
    await record('accepted', { outpoint: oldOutpoint, submissions });

    await current.close();
    // JSON round-trip models storage serialization. The actual browser/IndexedDB
    // process restart remains a separate manual check; this is wallet recreation.
    const snapshot = JSON.parse(JSON.stringify(stored)) as Record<string, unknown>;
    for (const key of Object.keys(stored)) delete stored[key];
    Object.assign(stored, snapshot);
    const beforeRestart = submissions;
    current = await openSession();
    await catchUpDelegation(current.wallet);
    expect(submissions).toBe(beforeRestart);
    expect((await listDelegationSubmissions(scope)).some((item) => item.outpoint === oldOutpoint && item.status === 'delegated')).toBe(true);
    await record('wallet-recreated-without-resubmission');
    await current.close();

    // The application correctly skips already-accepted coins. A separate SDK-only
    // session replaces this disposable coin's schedule for a prompt offline test.
    // No production threshold, chain time, or shared service config is modified.
    current = await openSession(false);
    const contracts = await (await current.wallet.getContractManager()).getContractsWithVtxos({ type: ['delegate'] });
    const selected = contracts.flatMap(({ vtxos }) => vtxos).filter((coin) => `${coin.txid}:${coin.vout}` === oldOutpoint);
    expect(selected).toHaveLength(1);
    const manager = await current.wallet.getDelegateManager();
    if (!manager) throw new Error('Delegate manager unavailable.');
    const executeAt = new Date(Date.now() + 90_000);
    const result = await manager.delegate(selected, await current.wallet.getAddress(), executeAt);
    expect(result.failed.length).toBe(0);
    expect(result.delegated.length).toBe(1);
    await current.close();
    session = undefined;
    await record('offline-renewal-scheduled', { outpoint: oldOutpoint, executeAt: executeAt.toISOString() });

    // No wallet or signer runs during this wait. A coordinator may restart Fulmine
    // now to separately verify that its accepted task survives a service restart.
    const indexer = new RestIndexerProvider(operatorUrl);
    await waitFor('Fulmine spending the original coin while the wallet is offline', async () => {
      const { vtxos } = await indexer.getVtxos({ outpoints: [{ txid: original.txid, vout: original.vout }] });
      return vtxos.find((coin) => coin.isSpent || coin.spentBy);
    }, 240_000);
    await record('original-spent-while-offline');

    // Empty SDK repositories force rediscovery from services. Extension acceptance
    // records remain intact so maintenance must verify the old coin's spent state.
    storage = {
      walletRepository: new InMemoryWalletRepository(),
      contractRepository: new InMemoryContractRepository(),
    };
    current = await openSession();
    const replacement = await waitFor('replacement discovery', async () => {
      const coins = await current.wallet.getVtxos();
      return coins.find((coin) => !coin.isSpent && !coin.spentBy && `${coin.txid}:${coin.vout}` !== oldOutpoint);
    });
    expect(replacement.value).toBe(original.value);
    const oldExpiry = expiresAtMs(original);
    const newExpiry = expiresAtMs(replacement);
    expect(oldExpiry).not.toBeNull();
    expect(newExpiry).not.toBeNull();
    expect(newExpiry!).toBeGreaterThan(oldExpiry!);
    const replacementOutpoint = `${replacement.txid}:${replacement.vout}`;
    await waitFor('replacement acceptance and obsolete record cleanup', async () => {
      await catchUpDelegation(current.wallet);
      const records = await listDelegationSubmissions(scope);
      return !records.some((item) => item.outpoint === oldOutpoint)
        && records.some((item) => item.outpoint === replacementOutpoint && item.status === 'delegated') ? true : undefined;
    });
    await record('passed', { replacementOutpoint, value: replacement.value, oldExpiry, newExpiry });
  } finally {
    await session?.close();
    vi.unstubAllGlobals();
  }
});
