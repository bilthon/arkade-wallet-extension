import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import { resolve } from 'node:path';
import { defineConfig } from 'wxt';
import { version } from './package.json';

const DEV_PROFILE_DIR = resolve(import.meta.dirname, '.dev-browser-profiles');

function getGitRevision(): string {
  const options: ExecFileSyncOptionsWithStringEncoding = {
    cwd: import.meta.dirname,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  };
  try {
    const commit = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], options).trim();
    const changes = execFileSync('git', ['status', '--porcelain'], options).trim();
    return changes ? `${commit}-dirty` : commit;
  } catch {
    // Source archives may not include Git metadata.
    return 'unknown';
  }
}

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  vite: () => ({
    define: {
      __APP_VERSION__: JSON.stringify(version),
      __GIT_REVISION__: JSON.stringify(getGitRevision()),
    },
  }),
  webExt: {
    chromiumProfile: resolve(DEV_PROFILE_DIR, 'chrome'),
    firefoxProfile: resolve(DEV_PROFILE_DIR, 'firefox'),
    keepProfileChanges: true,
    // Temporary add-ons are uninstalled when Firefox closes. Keep their stable UUID
    // and extension storage in this dedicated dev profile so the next run can reuse it.
    firefoxPref: {
      'extensions.webextensions.keepStorageOnUninstall': true,
      'extensions.webextensions.keepUuidOnUninstall': true,
    },
  },
  manifest: ({ browser, command }) => ({
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
    // A stable ID lets Firefox associate temporary installs with the same storage.
    ...(browser === 'firefox' && command === 'serve'
      ? { browser_specific_settings: { gecko: { id: 'arkade-wallet-dev@arkade.local' } } }
      : {}),
  }),
});
