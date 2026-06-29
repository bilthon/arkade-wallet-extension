import { describe, it, expect } from 'vitest';
import { deriveOrigin, OriginError, type MessageSenderLike } from './origin';

/**
 * M4 origin verification (PLAN.md §7). The single most attack-prone decision in the
 * provider: the origin must come ONLY from the browser-attested sender, never a
 * message body. These tests pin: https accepted, loopback-http accepted (dev),
 * http/null/opaque rejected, and that a forged body-origin can't override the sender.
 */

function sender(partial: MessageSenderLike): MessageSenderLike {
  return partial;
}

describe('deriveOrigin', () => {
  it('accepts an https origin from sender.origin', () => {
    expect(deriveOrigin(sender({ origin: 'https://site.example' }))).toBe(
      'https://site.example',
    );
  });

  it('accepts https with a port and strips any path', () => {
    // sender.origin is already an origin, but tab.url fallback must reduce to origin.
    expect(
      deriveOrigin(sender({ tab: { url: 'https://site.example:8443/some/path?q=1' } })),
    ).toBe('https://site.example:8443');
  });

  it('prefers sender.origin over sender.tab.url', () => {
    expect(
      deriveOrigin(
        sender({
          origin: 'https://real.example',
          tab: { url: 'https://attacker.example/path' },
        }),
      ),
    ).toBe('https://real.example');
  });

  it('accepts http for loopback hosts (dev)', () => {
    expect(deriveOrigin(sender({ origin: 'http://localhost:5173' }))).toBe(
      'http://localhost:5173',
    );
    expect(deriveOrigin(sender({ origin: 'http://127.0.0.1:3000' }))).toBe(
      'http://127.0.0.1:3000',
    );
  });

  it('rejects a non-loopback http origin', () => {
    expect(() => deriveOrigin(sender({ origin: 'http://site.example' }))).toThrow(
      OriginError,
    );
    try {
      deriveOrigin(sender({ origin: 'http://site.example' }));
    } catch (e) {
      expect((e as OriginError).code).toBe('INSECURE_ORIGIN');
    }
  });

  it('rejects an opaque "null" origin', () => {
    try {
      deriveOrigin(sender({ origin: 'null' }));
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(OriginError);
      expect((e as OriginError).code).toBe('OPAQUE_ORIGIN');
    }
  });

  it('rejects a file:// origin via tab.url', () => {
    expect(() =>
      deriveOrigin(sender({ tab: { url: 'file:///Users/x/index.html' } })),
    ).toThrow(OriginError);
  });

  it('rejects when there is no origin and no tab url', () => {
    try {
      deriveOrigin(sender({}));
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as OriginError).code).toBe('NO_ORIGIN');
    }
  });

  it('rejects an undefined sender', () => {
    expect(() => deriveOrigin(undefined)).toThrow(OriginError);
  });

  it('cannot be overridden by a spoofed body-supplied origin (sender is the only source)', () => {
    // deriveOrigin's signature only accepts a sender — there is no body parameter to
    // spoof. This test documents that contract: even if a web app posts {origin: '...'}
    // in the message body, the SW derives from sender alone.
    const s = sender({ origin: 'https://real.example' });
    // Simulate a malicious body that the handler must ignore.
    const maliciousBody = { origin: 'https://bank.example' };
    expect(deriveOrigin(s)).toBe('https://real.example');
    expect(deriveOrigin(s)).not.toBe(maliciousBody.origin);
  });
});
