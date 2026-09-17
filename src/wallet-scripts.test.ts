import { describe, expect, it } from 'vitest';
import { DefaultVtxo, DelegateVtxo, SingleKey, type Contract, type Wallet } from '@arkade-os/sdk';
import { hex } from '@scure/base';
import { ownedContractScript } from './wallet-scripts';
import { buildInspectContext } from './signing';

const buyer = await SingleKey.fromHex('11'.repeat(32)).xOnlyPublicKey();
const operator = await SingleKey.fromHex('22'.repeat(32)).xOnlyPublicKey();
const delegate = await SingleKey.fromHex('33'.repeat(32)).xOnlyPublicKey();
const options = { pubKey: buyer, serverPubKey: operator, csvTimelock: { type: 'blocks' as const, value: 144n } };
const normal = new DefaultVtxo.Script(options);
const delegated = new DelegateVtxo.Script({ ...options, delegatePubKey: delegate });
/** A live script that is NOT in the contract store, so stored ones must be re-derived. */
const boarding = new DefaultVtxo.Script({ ...options, csvTimelock: { type: 'blocks', value: 288n } });
const someoneElses = new DefaultVtxo.Script({ ...options, pubKey: delegate });
function contract(type: 'default' | 'delegate'): Contract {
  const script = type === 'default' ? normal : delegated;
  return {
    type, script: hex.encode(script.pkScript), address: script.address('tark', operator).encode(),
    state: 'active', createdAt: 0,
    params: { pubKey: hex.encode(buyer), serverPubKey: hex.encode(operator),
      csvTimelock: '144', ...(type === 'delegate' ? { delegatePubKey: hex.encode(delegate) } : {}) },
  };
}

describe('wallet-owned scripts', () => {
  it('recognizes ordinary and historical delegated scripts for this identity', () => {
    expect(ownedContractScript(contract('default'), hex.encode(buyer))).toEqual(normal.pkScript);
    expect(ownedContractScript(contract('delegate'), hex.encode(buyer))).toEqual(delegated.pkScript);
  });

  it('rejects custom contracts, another identity, and metadata/script mismatches', () => {
    const stored = contract('default');
    expect(ownedContractScript({ ...stored, type: 'escrow' }, hex.encode(buyer))).toBeNull();
    expect(ownedContractScript(stored, hex.encode(delegate))).toBeNull();
    expect(ownedContractScript({ ...stored, script: hex.encode(delegated.pkScript) }, hex.encode(buyer))).toBeNull();
  });

  it('includes live and historical scripts while skipping malformed stored scripts', async () => {
    const stored = contract('default');
    const foreign: Contract = {
      ...stored,
      script: hex.encode(someoneElses.pkScript),
      params: { ...stored.params, pubKey: hex.encode(delegate) },
    };
    const wallet = {
      identity: { xOnlyPublicKey: async () => buyer }, arkServerPublicKey: operator,
      offchainTapscript: delegated, boardingTapscript: boarding,
      getContractManager: async () => ({
        getContracts: async () => [
          ...[undefined, null, 42].map((script) => ({ ...stored, script })),
          contract('default'), contract('delegate'), foreign,
        ],
      }),
    } as unknown as Wallet;
    const inspected = await buildInspectContext({ wallet, network: 'regtest', epoch: 1, assertCurrent() {} }, 330);
    expect(inspected.ownScriptsHex).toEqual(new Set(
      [delegated, boarding, normal].map((s) => hex.encode(s.pkScript)),
    ));
  });
});
