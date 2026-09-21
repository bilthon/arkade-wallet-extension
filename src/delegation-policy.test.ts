import { describe, expect, it } from 'vitest';
import { ArkAddress, Intent, SingleKey } from '@arkade-os/sdk';
import { base64, hex } from '@scure/base';
import { assertZeroIntentFees, validateDelegationIntent } from './delegation-policy';

const key = SingleKey.fromHex('11'.repeat(32));
const pubkey = hex.encode(await key.compressedPublicKey());
const address = new ArkAddress(await key.xOnlyPublicKey(), await key.xOnlyPublicKey(), 'tark');
const approved = { url: 'http://delegate', pubkey, delegateAddress: address.encode(), fee: '0' as const };
function intent(amount = 1000n, destination = address.pkScript) {
  const message: Intent.RegisterMessage = {
    type: 'register', onchain_output_indexes: [], valid_at: 1, expire_at: 0, cosigners_public_keys: [pubkey],
  };
  const proof = Intent.create(message, [{
    txid: hex.decode('22'.repeat(32)), index: 0, witnessUtxo: { script: address.pkScript, amount: 1000n },
  }], [{ script: destination, amount }]);
  return { message, proof: base64.encode(proof.toPSBT()) };
}

describe('delegation policy', () => {
  it('allows only a constant zero operator policy', () => {
    expect(() => assertZeroIntentFees({ offchainInput: '0', onchainInput: '' })).not.toThrow();
    expect(() => assertZeroIntentFees({ offchainInput: '1' })).toThrow('zero operator fees');
    expect(() => assertZeroIntentFees({ offchainInput: 'now() > expiry ? 1 : 0' })).toThrow('zero operator fees');
  });

  it('accepts the intent fees read from the custom arkd v0.9.4 stack on 2026-09-17', () => {
    const intentFee = { offchainInput: '', offchainOutput: '', onchainInput: '', onchainOutput: '' };
    expect(() => assertZeroIntentFees(intentFee)).not.toThrow();
  });

  it('accepts decimal zero formatting without accepting formulas or underflow', () => {
    expect(() => assertZeroIntentFees({ offchainInput: ' 0.0 ', onchainInput: '+0.00' })).not.toThrow();
    for (const expression of ['0 * x', '1e-999', '0.001', 'NaN']) {
      expect(() => assertZeroIntentFees({ offchainInput: expression })).toThrow('zero operator fees');
    }
  });

  it('accepts a zero-fee intent returning all value to this wallet', () => {
    expect(() => validateDelegationIntent(intent(), approved, address.encode())).not.toThrow();
  });

  it('rejects reduced value, redirected funds, extra cosigners, and onchain outputs', () => {
    expect(() => validateDelegationIntent(intent(999n), approved, address.encode())).toThrow();
    expect(() => validateDelegationIntent(intent(1000n, new Uint8Array([0x6a])), approved, address.encode())).toThrow();
    const additionalSigner = intent();
    additionalSigner.message.cosigners_public_keys.push(pubkey);
    expect(() => validateDelegationIntent(additionalSigner, approved, address.encode())).toThrow();
    const onchain = intent();
    onchain.message.onchain_output_indexes.push(0);
    expect(() => validateDelegationIntent(onchain, approved, address.encode())).toThrow();
  });
});
