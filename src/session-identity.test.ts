import { describe, expect, it, vi } from 'vitest';
import { SeedIdentity, SingleKey, Wallet, type ArkProvider } from '@arkade-os/sdk';
import { sessionIdentity } from './session-identity';

describe('session identity', () => {
  it.each([
    { isMainnet: true, operatorNetwork: 'regtest' },
    { isMainnet: false, operatorNetwork: 'bitcoin' },
  ])('preserves the SDK network mismatch check: %j', async ({ isMainnet, operatorNetwork }) => {
    const raw = SeedIdentity.fromSeed(new Uint8Array(64).fill(7), { isMainnet });
    const identity = sessionIdentity(raw, () => {});
    const arkProvider = {
      getInfo: async () => ({ network: operatorNetwork }),
    } as unknown as ArkProvider;
    await expect(Wallet.create({
      identity, arkProvider, indexerUrl: 'http://localhost:7071', settlementConfig: false,
    })).rejects.toThrow('Network mismatch');
  });

  it('revokes transaction, message, and existing batch signers after session invalidation', async () => {
    const raw = SingleKey.fromHex('11'.repeat(32));
    const sign = vi.spyOn(raw, 'sign');
    const message = vi.spyOn(raw, 'signMessage');
    let current = true;
    const identity = sessionIdentity(raw, () => { if (!current) throw new Error('LOCKED'); });
    const batch = identity.signerSession();
    current = false;
    await expect(identity.sign({} as never)).rejects.toThrow('LOCKED');
    await expect(identity.signMessage(new Uint8Array(32), 'schnorr')).rejects.toThrow('LOCKED');
    await expect(batch.sign()).rejects.toThrow('LOCKED');
    await expect(batch.getNonces()).rejects.toThrow('LOCKED');
    expect(sign).not.toHaveBeenCalled();
    expect(message).not.toHaveBeenCalled();
  });

  it('preserves public identity and ordinary authorized message signing', async () => {
    const raw = SingleKey.fromHex('22'.repeat(32));
    const identity = sessionIdentity(raw, () => {});
    expect(await identity.xOnlyPublicKey()).toEqual(await raw.xOnlyPublicKey());
    expect(await identity.compressedPublicKey()).toEqual(await raw.compressedPublicKey());
    expect(await identity.signMessage(new Uint8Array(32), 'schnorr')).toHaveLength(64);
  });
});
