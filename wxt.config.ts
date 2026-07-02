import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Arkade Wallet',
    // `tabs`: needed to deliver provider events (disconnect/networkChanged) to the
    // pages of a CONNECTED site. Least-privilege (security review): we never call
    // `tabs.query({})` — `emitToOrigin` scopes the query to a `scheme://host/*` match
    // pattern built from an already-granted origin, so we only ever read tabs at an
    // origin the user has connected; we do not enumerate every open tab's URL.
    // `chrome.windows.create` (the approval window) needs no permission.
    permissions: ['storage', 'alarms', 'offscreen', 'tabs'],
    // host_permissions = the operator + esplora endpoints the BACKGROUND SW must
    // `fetch()` (Wallet.create talks to arkd + esplora). MV3 blocks SW cross-origin
    // requests without these, which silently hangs every wallet-building read/sign.
    // This is SEPARATE from the `tabs` event-delivery concern above — scoped to the
    // known networks (NETWORK_CONFIG), NOT a broad <all_urls> grant.
    // (Add delegate.arkade.money later when delegation lands.)
    host_permissions: [
      'http://localhost/*', // regtest arkd :7070 + esplora :30000 + boltz :9069 (ports not allowed in match patterns)
      'http://127.0.0.1/*',
      'https://*.arkade.sh/*', // mutinynet / signet / testnet operators + their boltz (api.boltz.*.arkade.sh)
      'https://arkade.computer/*', // mainnet operator
      'https://mutinynet.com/*', // mutinynet esplora
      'https://mempool.space/*', // signet / testnet / mainnet esplora
      'https://api.ark.boltz.exchange/*', // mainnet boltz (the only boltz host not under *.arkade.sh)
    ],
    // No remote code / eval. script-src 'self'; object-src 'none'.
    // `frame-ancestors 'none'`: NO extension page — popup OR approval window —
    // may be embedded in an iframe by a dapp (anti-clickjacking). script-src 'self' is
    // unchanged (not weakened).
    // ponytail: KDF ceiling — Argon2id-WASM needs 'wasm-unsafe-eval' added to
    // script-src here (or demote to PBKDF2-600k). Don't add it now; resolve the
    // Argon2id-WASM-under-CSP question before locking the vault format.
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'none'; frame-ancestors 'none';",
    },
    // MAIN-world provider is injected into pages by the ISOLATED content bridge
    // (wxt/utils/inject-script), so it must be web-accessible. The same mechanism
    // works for the Firefox port — already cross-browser.
    web_accessible_resources: [
      { resources: ['provider.js'], matches: ['<all_urls>'] },
    ],
  },
});
