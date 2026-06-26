import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Arkade Wallet',
    // `tabs`: needed to read each tab's URL when pushing provider events to connected
    // dapp pages (origin-matched). `chrome.windows.create` (the approval window) needs
    // no permission. storage/alarms/offscreen unchanged.
    permissions: ['storage', 'alarms', 'offscreen', 'tabs'],
    // PLAN.md §7: no remote code / eval. script-src 'self'; object-src 'none'.
    // `frame-ancestors 'none'` (Track E2a): NO extension page — popup OR approval window —
    // may be embedded in an iframe by a dapp (anti-clickjacking). script-src 'self' is
    // unchanged (not weakened).
    // ponytail: Phase-1 KDF ceiling — Argon2id-WASM needs 'wasm-unsafe-eval' added to
    // script-src here (or demote to PBKDF2-600k). Do NOT add it in Phase 0; resolve in the
    // Phase-1 Argon2id-WASM-under-CSP spike before locking the vault format (BUILD_PLAN §C/Phase1).
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'none'; frame-ancestors 'none';",
    },
    // MAIN-world provider is injected into pages by the ISOLATED content bridge
    // (wxt/utils/inject-script), so it must be web-accessible. Same mechanism the
    // PLAN names for the Firefox port — already cross-browser.
    web_accessible_resources: [
      { resources: ['provider.js'], matches: ['<all_urls>'] },
    ],
  },
});
