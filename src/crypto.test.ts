import { describe, it, expect } from 'vitest';
import { base64 } from '@scure/base';
import {
  encryptVault,
  decryptVault,
  generateMnemonic,
  validateMnemonic,
  type VaultBlob,
} from './crypto';

/**
 * The one runnable Track-B check (PLAN.md §7). Proves the at-rest vault is sound:
 * round-trips a mnemonic, rejects a wrong password, rejects tampered
 * ciphertext / IV / auth-tag (GCM fails closed → never returns plaintext), rejects
 * a network mismatch (AAD binding), and uses a fresh IV per encrypt.
 *
 * THROWAWAY test mnemonic only — the canonical all-`abandon` BIP39 vector. Never a
 * real or funded seed.
 */
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSWORD = 'correct horse battery staple';

// Flip one byte of a base64 field to simulate at-rest tampering.
function flipByte(b64: string, index = 0): string {
  const bytes = base64.decode(b64);
  bytes[index] ^= 0xff;
  return base64.encode(bytes);
}

describe('vault crypto', () => {
  it('generates and validates BIP39 mnemonics', () => {
    expect(generateMnemonic(128).split(' ')).toHaveLength(12);
    expect(generateMnemonic(256).split(' ')).toHaveLength(24);
    expect(validateMnemonic(TEST_MNEMONIC)).toBe(true);
    expect(validateMnemonic('not a real mnemonic at all here please')).toBe(false);
  });

  it('round-trips a mnemonic through encrypt → decrypt', async () => {
    const blob = await encryptVault(TEST_MNEMONIC, PASSWORD, 'regtest');
    expect(blob.v).toBe(1);
    expect(blob.kdf).toBe('pbkdf2');
    expect(blob.kdfParams.iterations).toBeGreaterThanOrEqual(600_000);
    await expect(decryptVault(blob, PASSWORD, 'regtest')).resolves.toBe(TEST_MNEMONIC);
  });

  it('rejects a wrong password', async () => {
    const blob = await encryptVault(TEST_MNEMONIC, PASSWORD, 'regtest');
    await expect(decryptVault(blob, 'wrong password', 'regtest')).rejects.toThrow(/authentication failed/);
  });

  it('rejects tampered ciphertext (GCM auth tag)', async () => {
    const blob = await encryptVault(TEST_MNEMONIC, PASSWORD, 'regtest');
    const tampered: VaultBlob = { ...blob, ct: flipByte(blob.ct) };
    await expect(decryptVault(tampered, PASSWORD, 'regtest')).rejects.toThrow(/authentication failed/);
  });

  it('rejects a tampered auth tag (last 16 ct bytes)', async () => {
    const blob = await encryptVault(TEST_MNEMONIC, PASSWORD, 'regtest');
    const ctLen = base64.decode(blob.ct).length;
    const tampered: VaultBlob = { ...blob, ct: flipByte(blob.ct, ctLen - 1) };
    await expect(decryptVault(tampered, PASSWORD, 'regtest')).rejects.toThrow(/authentication failed/);
  });

  it('rejects a tampered IV', async () => {
    const blob = await encryptVault(TEST_MNEMONIC, PASSWORD, 'regtest');
    const tampered: VaultBlob = { ...blob, iv: flipByte(blob.iv) };
    await expect(decryptVault(tampered, PASSWORD, 'regtest')).rejects.toThrow(/authentication failed/);
  });

  it('rejects a network mismatch (additionalData binding)', async () => {
    const blob = await encryptVault(TEST_MNEMONIC, PASSWORD, 'regtest');
    await expect(decryptVault(blob, PASSWORD, 'mutinynet')).rejects.toThrow(/authentication failed/);
  });

  it('rejects a downgraded KDF iteration count (offline brute-force defense)', async () => {
    const blob = await encryptVault(TEST_MNEMONIC, PASSWORD, 'regtest');
    const weakened: VaultBlob = { ...blob, kdfParams: { ...blob.kdfParams, iterations: 1 } };
    await expect(decryptVault(weakened, PASSWORD, 'regtest')).rejects.toThrow(/authentication failed/);
  });

  it('uses a fresh IV (and ciphertext) on each encrypt', async () => {
    const a = await encryptVault(TEST_MNEMONIC, PASSWORD, 'regtest');
    const b = await encryptVault(TEST_MNEMONIC, PASSWORD, 'regtest');
    expect(a.iv).not.toBe(b.iv);
    expect(a.salt).not.toBe(b.salt);
    expect(a.ct).not.toBe(b.ct);
    // Both still decrypt to the same secret.
    await expect(decryptVault(a, PASSWORD, 'regtest')).resolves.toBe(TEST_MNEMONIC);
    await expect(decryptVault(b, PASSWORD, 'regtest')).resolves.toBe(TEST_MNEMONIC);
  });
});
