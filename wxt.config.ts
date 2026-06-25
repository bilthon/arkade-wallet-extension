import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Arkade Wallet',
    permissions: ['storage', 'alarms', 'offscreen'],
    // PLAN.md §7: no remote code / eval. script-src 'self'; object-src 'none'.
    // ponytail: Phase-1 KDF ceiling — Argon2id-WASM needs 'wasm-unsafe-eval' added to
    // script-src here (or demote to PBKDF2-600k). Do NOT add it in Phase 0; resolve in the
    // Phase-1 Argon2id-WASM-under-CSP spike before locking the vault format (BUILD_PLAN §C/Phase1).
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'none';",
    },
  },
});
