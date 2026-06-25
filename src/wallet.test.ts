import { describe, it, expect } from 'vitest';
import { NETWORK_CONFIG, networkConfig } from './wallet';

/**
 * Track-C check: the network → operator/esplora/derivation mapping is the one piece
 * of `wallet.ts` with branching logic worth pinning (the rest is thin SDK
 * pass-through exercised live against nigiri). We assert the regtest defaults
 * (arkd :7070, electrs REST :30000, testnet derivation) and that
 * mainnet is the only `isMainnet: true` network.
 */
describe('network config mapping', () => {
  it('maps regtest to nigiri local services with testnet derivation', () => {
    const cfg = networkConfig('regtest');
    expect(cfg.arkServerUrl).toBe('http://localhost:7070');
    expect(cfg.esploraUrl).toBe('http://localhost:30000');
    expect(cfg.isMainnet).toBe(false);
  });

  it('only mainnet derives as mainnet (BIP86 coin type 0)', () => {
    expect(networkConfig('bitcoin').isMainnet).toBe(true);
    for (const name of ['regtest', 'mutinynet', 'signet', 'testnet'] as const) {
      expect(networkConfig(name).isMainnet).toBe(false);
    }
  });

  it('covers every NetworkName with a non-empty operator + esplora URL', () => {
    for (const [name, cfg] of Object.entries(NETWORK_CONFIG)) {
      expect(cfg.arkServerUrl, `${name} arkServerUrl`).toMatch(/^https?:\/\//);
      expect(cfg.esploraUrl, `${name} esploraUrl`).toMatch(/^https?:\/\//);
    }
  });
});
