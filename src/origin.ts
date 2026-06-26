/**
 * The fields we read off a message sender. Chrome's MV3 `MessageSender` carries
 * `origin` (the page origin) and `tab.url`, but `@types/webextension-polyfill`'s
 * `MessageSender` omits `origin` (it's Chrome-specific). We type structurally against
 * just what we need so we don't depend on either library's exact sender shape — the
 * messaging layer hands us a runtime object that has these at run time on Chrome.
 */
export interface MessageSenderLike {
  origin?: string | null;
  tab?: { url?: string } | null;
}

/**
 * M4-critical: SW-side origin derivation (PLAN.md §7, BUILD_PLAN Phase 3 Track E).
 *
 * The requesting origin is derived ONLY from the browser-attested message sender —
 * `sender.origin` (preferred) or `sender.tab.url`. It is NEVER read from a message
 * body field a dapp can forge. Every dapp-facing handler keys its grant lookup and
 * approval prompt off the value this module returns; a dapp cannot impersonate
 * another origin because it never gets to supply the string.
 *
 * Rejected, with no grant possible:
 *  • null / opaque origins ("null") — sandboxed iframes, data:/blob: documents,
 *    `file://`, srcdoc — anything without a trustworthy site identity.
 *  • `http:` origins — only secure (`https:`) contexts may connect; a wallet over
 *    plaintext HTTP is trivially MITM'd.
 *
 * `localhost`/`127.0.0.1` over http is allowed (dev: the test-dapp + local dapps run
 * there and browsers treat them as secure contexts).
 */

export class OriginError extends Error {
  constructor(
    readonly code: 'NO_ORIGIN' | 'OPAQUE_ORIGIN' | 'INSECURE_ORIGIN',
    message: string,
  ) {
    super(message);
    this.name = 'OriginError';
  }
}

/** localhost / 127.0.0.1 / [::1] — treated as secure even over http (dev). */
function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

/**
 * Derive the requesting page's origin from the browser-attested `sender`, or throw
 * `OriginError`. Prefers `sender.origin` (set by Chrome for content-script senders);
 * falls back to parsing `sender.tab.url`'s origin when `origin` is absent. Returns a
 * canonical `scheme://host[:port]` string — the key for grants and the label shown
 * (verbatim, never a dapp-supplied name) in the approval window.
 */
export function deriveOrigin(sender: MessageSenderLike | undefined): string {
  const raw = senderOrigin(sender);
  if (raw === undefined || raw === null || raw === '') {
    throw new OriginError('NO_ORIGIN', 'Request has no verifiable origin.');
  }
  // "null" is how the browser serializes an opaque origin (sandboxed iframe, data:,
  // file: in some contexts). Never grant to it.
  if (raw === 'null') {
    throw new OriginError('OPAQUE_ORIGIN', 'Request comes from an opaque (null) origin.');
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OriginError('OPAQUE_ORIGIN', `Unparseable origin: ${raw}`);
  }

  if (url.protocol === 'https:') {
    return url.origin;
  }
  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) {
    return url.origin; // dev loopback is a secure context
  }
  throw new OriginError(
    'INSECURE_ORIGIN',
    `Only https origins may connect (got ${url.protocol}//${url.host}).`,
  );
}

/**
 * The raw origin string from the sender, preferring `sender.origin` and falling back
 * to the origin of `sender.tab.url`. Returns undefined when neither is present.
 * Purely structural — does no validation (that is `deriveOrigin`'s job).
 */
function senderOrigin(sender: MessageSenderLike | undefined): string | undefined {
  if (!sender) return undefined;
  // Chrome populates `origin` for messages from content scripts in a page context.
  if (typeof sender.origin === 'string' && sender.origin.length > 0) {
    return sender.origin;
  }
  // Fallback: the tab's document URL → its origin. We only ever take the ORIGIN of
  // this URL, never the full path, so a crafted path can't widen the grant.
  if (sender.tab?.url) {
    try {
      return new URL(sender.tab.url).origin;
    } catch {
      return undefined;
    }
  }
  return undefined;
}
