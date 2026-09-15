import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('WXT_REGTEST_ARK_PORT', undefined);
  vi.stubEnv('WXT_REGTEST_ESPLORA_PORT', undefined);
});

afterEach(() => vi.unstubAllEnvs());

describe('regtest endpoints', () => {
  it('defaults to Nigiri without environment overrides', async () => {
    const { NETWORK_CONFIG } = await import('./wallet');
    expect(NETWORK_CONFIG.regtest).toMatchObject({
      arkServerUrl: 'http://localhost:7070',
      esploraUrl: 'http://localhost:30000',
    });
  });

  it('supports independent overrides', async () => {
    vi.stubEnv('WXT_REGTEST_ESPLORA_PORT', '30010');
    expect((await import('./wallet')).NETWORK_CONFIG.regtest).toMatchObject({
      arkServerUrl: 'http://localhost:7070',
      esploraUrl: 'http://localhost:30010',
    });
    vi.resetModules();
    vi.stubEnv('WXT_REGTEST_ARK_PORT', '7071');
    expect((await import('./wallet')).NETWORK_CONFIG.regtest.arkServerUrl)
      .toBe('http://localhost:7071');
  });

  it('accepts the valid port boundaries', async () => {
    vi.stubEnv('WXT_REGTEST_ARK_PORT', '1');
    vi.stubEnv('WXT_REGTEST_ESPLORA_PORT', '65535');
    expect((await import('./wallet')).NETWORK_CONFIG.regtest).toMatchObject({
      arkServerUrl: 'http://localhost:1',
      esploraUrl: 'http://localhost:65535',
    });
  });

  it.each(['', '0', '65536', '-1', '7070.5', '7e3', 'abc', '7071/path'])(
    'rejects invalid port %j with the variable name', async (value) => {
      vi.stubEnv('WXT_REGTEST_ARK_PORT', value);
      await expect(import('./wallet')).rejects.toThrow('WXT_REGTEST_ARK_PORT');
    },
  );
});
