import { describe, it, expect } from 'vitest';
import { ArkAddress, networks, type NetworkName } from '@arkade-os/sdk';
import {
  validateArkadeAddress,
  validateAmount,
  validateOnchainAddress,
  SendValidationError,
  DUST_SATS,
} from './wallet';

/**
 * Off-chain send validation (the protocol-critical core).
 *
 * `validateArkadeAddress` / `validateAmount` are the SW-side guards that run BEFORE
 * any signing. They are pure (no wallet/operator), so we exercise every reject path
 * and the per-network HRP rule directly. Addresses are built with the SDK's
 * `ArkAddress` so the fixtures are real bech32m, not hand-rolled strings.
 */

// Build a real Arkade address with a given HRP (server/vtxo keys are arbitrary 32B).
function arkAddr(hrp: string): string {
  const server = new Uint8Array(32).fill(2);
  const vtxo = new Uint8Array(32).fill(3);
  return new ArkAddress(server, vtxo, hrp).encode();
}

const TARK = arkAddr('tark'); // testnet/signet/mutinynet/regtest
const ARK = arkAddr('ark'); //  mainnet

/** Run validation and return the thrown SendValidationError (or fail if none). */
function expectReject(fn: () => void): SendValidationError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(SendValidationError);
    return e as SendValidationError;
  }
  throw new Error('expected a SendValidationError, but validation passed');
}

describe('validateArkadeAddress — per-network HRP', () => {
  it('accepts a tark… address on every testnet-family network', () => {
    for (const net of ['regtest', 'mutinynet', 'signet', 'testnet'] as NetworkName[]) {
      expect(() => validateArkadeAddress(TARK, net)).not.toThrow();
    }
  });

  it('accepts an ark… address on mainnet', () => {
    expect(() => validateArkadeAddress(ARK, 'bitcoin')).not.toThrow();
  });

  it('rejects a mainnet ark… address on regtest as wrong-network', () => {
    const err = expectReject(() => validateArkadeAddress(ARK, 'regtest'));
    expect(err.code).toBe('ADDRESS_WRONG_NETWORK');
  });

  it('rejects a tark… address on mainnet as wrong-network', () => {
    const err = expectReject(() => validateArkadeAddress(TARK, 'bitcoin'));
    expect(err.code).toBe('ADDRESS_WRONG_NETWORK');
  });

  it('tolerates surrounding whitespace on a valid address', () => {
    expect(() => validateArkadeAddress(`  ${TARK}  `, 'regtest')).not.toThrow();
  });
});

describe('validateArkadeAddress — on-chain rejection (offboard is separate)', () => {
  const onchain: Array<[NetworkName, string]> = [
    ['regtest', 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080'],
    ['bitcoin', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'],
    ['mutinynet', 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'],
  ];

  it.each(onchain)('rejects an on-chain address on %s', (net, addr) => {
    const err = expectReject(() => validateArkadeAddress(addr, net));
    expect(err.code).toBe('ADDRESS_ONCHAIN');
    expect(err.message.toLowerCase()).toContain('on-chain');
  });

  it('uses the active network bech32 HRP to flag on-chain', () => {
    // sanity: the network table really does carry distinct segwit HRPs
    expect(networks.regtest.bech32).toBe('bcrt');
    expect(networks.bitcoin.bech32).toBe('bc');
  });
});

describe('validateArkadeAddress — malformed', () => {
  it.each([['empty', ''], ['whitespace', '   '], ['garbage', 'not-an-address'], ['truncated', TARK.slice(0, -6)]])(
    'rejects %s input as malformed',
    (_label, addr) => {
      const err = expectReject(() => validateArkadeAddress(addr, 'regtest'));
      expect(err.code).toBe('ADDRESS_MALFORMED');
    },
  );
});

describe('validateOnchainAddress — network routing', () => {
  it('accepts the active network HRP', () => {
    expect(() => validateOnchainAddress('bcrt1qtest', 'regtest')).not.toThrow();
    expect(() => validateOnchainAddress('bc1qtest', 'bitcoin')).not.toThrow();
    expect(() => validateOnchainAddress('tb1qtest', 'mutinynet')).not.toThrow();
    expect(() => validateOnchainAddress('tb1qtest', 'signet')).not.toThrow();
    expect(() => validateOnchainAddress('tb1qtest', 'testnet')).not.toThrow();
  });

  it('rejects a cross-network on-chain address (bc1… on regtest)', () => {
    const err = expectReject(() => validateOnchainAddress('bc1qtest', 'regtest'));
    expect(err.code).toBe('ADDRESS_WRONG_NETWORK');
    expect(err.message).toContain('bcrt1');
  });

  it('rejects an Arkade address as malformed', () => {
    const err = expectReject(() => validateOnchainAddress(TARK, 'regtest'));
    expect(err.code).toBe('ADDRESS_MALFORMED');
  });

  it('rejects empty input as malformed', () => {
    const err = expectReject(() => validateOnchainAddress('', 'regtest'));
    expect(err.code).toBe('ADDRESS_MALFORMED');
  });
});

describe('validateAmount — bounds', () => {
  const AVAILABLE = 100_000;

  it('accepts an integer at/above dust and within balance', () => {
    expect(() => validateAmount(DUST_SATS, AVAILABLE)).not.toThrow();
    expect(() => validateAmount(50_000, AVAILABLE)).not.toThrow();
    expect(() => validateAmount(AVAILABLE, AVAILABLE)).not.toThrow(); // exactly all
  });

  it('rejects a non-integer amount', () => {
    expect(expectReject(() => validateAmount(1000.5, AVAILABLE)).code).toBe('AMOUNT_NOT_INTEGER');
  });

  it('rejects zero and negative', () => {
    expect(expectReject(() => validateAmount(0, AVAILABLE)).code).toBe('AMOUNT_TOO_LOW');
    expect(expectReject(() => validateAmount(-1, AVAILABLE)).code).toBe('AMOUNT_TOO_LOW');
  });

  it('rejects below the dust floor', () => {
    expect(expectReject(() => validateAmount(DUST_SATS - 1, AVAILABLE)).code).toBe('AMOUNT_BELOW_DUST');
  });

  it('rejects an amount exceeding available balance', () => {
    expect(expectReject(() => validateAmount(AVAILABLE + 1, AVAILABLE)).code).toBe(
      'AMOUNT_EXCEEDS_BALANCE',
    );
  });
});
