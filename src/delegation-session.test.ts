import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ArkAddress, SingleKey, type Wallet } from '@arkade-os/sdk';
import { hex } from '@scure/base';
import type { SessionContext } from './wallet-runtime';
import type { DelegationConfig } from './delegation-state';

const mocks = vi.hoisted(() => ({
  read: vi.fn(), write: vi.fn(), ready: vi.fn(), begin: vi.fn(), build: vi.fn(),
  disposeSwaps: vi.fn(), reject: vi.fn(), lock: vi.fn(),
}));
vi.mock('./delegation-state', () => ({ getDelegationConfig: mocks.read, setDelegationConfig: mocks.write }));
vi.mock('./delegation-provider', async (original) => ({
  ...await original<typeof import('./delegation-provider')>(),
  createSessionDelegate: () => ({ assertDelegationAllowed: mocks.ready }),
}));
vi.mock('./wallet-runtime', () => ({ beginRuntimeWalletRebuild: mocks.begin, getSessionContext: mocks.build }));
vi.mock('./session-lock', () => ({ lockWallet: mocks.lock }));
vi.mock('./lightning', () => ({ disposeSwaps: mocks.disposeSwaps }));
vi.mock('./approvals', () => ({ rejectPendingApproval: mocks.reject }));
vi.mock('./wallet', () => ({ networkConfig: () => ({ arkServerUrl: 'http://localhost:7071', delegateUrl: 'http://localhost:7012' }) }));
import { configureDelegation } from './delegation-session';

const buyer = SingleKey.fromHex('11'.repeat(32));
const operator = SingleKey.fromHex('22'.repeat(32));
const config: DelegationConfig = {
  enabled: true, delegate: {
    url: 'http://localhost:7012', pubkey: hex.encode(await buyer.compressedPublicKey()), fee: '0',
    delegateAddress: new ArkAddress(await operator.xOnlyPublicKey(), await buyer.xOnlyPublicKey(), 'tark').encode(),
  },
};
let current: boolean;
let context: SessionContext;
let install: ReturnType<typeof vi.fn>;
let abort: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.clearAllMocks();
  current = true;
  context = {
    wallet: { identity: buyer, network: { hrp: 'tark' }, arkServerPublicKey: await operator.compressedPublicKey() } as unknown as Wallet,
    network: 'regtest', epoch: 1,
    assertCurrent: () => { if (!current) throw new Error('LOCKED'); },
  };
  install = vi.fn(() => true);
  abort = vi.fn();
  mocks.begin.mockImplementation(() => {
    current = false;
    return { disposal: Promise.resolve(), install, abort };
  });
  mocks.read.mockResolvedValue(config);
  mocks.write.mockResolvedValue(undefined);
  mocks.ready.mockResolvedValue(undefined);
  vi.stubGlobal('browser', { storage: { local: { remove: vi.fn(async () => {}) } } });
});

describe('delegation configuration transition', () => {
  it('checks approval before fencing, persists, and rebuilds the wallet', async () => {
    await configureDelegation(context, config);
    expect(mocks.ready).toHaveBeenCalledOnce();
    expect(mocks.write).toHaveBeenCalledWith({
      walletPublicKey: hex.encode(await buyer.xOnlyPublicKey()), network: 'regtest', operatorUrl: 'http://localhost:7071',
    }, config);
    expect(mocks.reject).toHaveBeenCalledOnce();
    expect(install).toHaveBeenCalledOnce();
    expect(mocks.build).toHaveBeenCalledOnce();
  });

  it('pauses the same delegate without a network request', async () => {
    await configureDelegation(context, { ...config, enabled: false });
    expect(mocks.ready).not.toHaveBeenCalled();
    expect(mocks.write).toHaveBeenCalledOnce();
  });

  it('rejects a second queued change from the old session', async () => {
    const first = configureDelegation(context, config);
    const second = configureDelegation(context, { ...config, enabled: false });
    await first;
    await expect(second).rejects.toThrow('LOCKED');
    expect(mocks.write).toHaveBeenCalledOnce();
  });

  it('aborts on storage failure and never reinstalls the old session', async () => {
    mocks.write.mockRejectedValueOnce(new Error('storage failed'));
    await expect(configureDelegation(context, config)).rejects.toThrow('storage failed');
    expect(abort).toHaveBeenCalledOnce();
    expect(install).not.toHaveBeenCalled();
    expect(mocks.build).not.toHaveBeenCalled();
  });

  it('does not rebuild when a lock cancels installation', async () => {
    install.mockReturnValue(false);
    await expect(configureDelegation(context, config)).rejects.toThrow('LOCKED');
    expect(mocks.build).not.toHaveBeenCalled();
  });

  it('rejects replacing the delegate through an offline pause', async () => {
    await expect(configureDelegation(context, {
      ...config, enabled: false, delegate: { ...config.delegate, pubkey: `02${'33'.repeat(32)}` },
    })).rejects.toThrow('Approve the delegate');
    expect(mocks.begin).not.toHaveBeenCalled();
  });

  it('does not touch configuration outside regtest', async () => {
    await expect(configureDelegation({ ...context, network: 'bitcoin' }, config)).rejects.toThrow('regtest only');
    expect(mocks.begin).not.toHaveBeenCalled();
  });
});
