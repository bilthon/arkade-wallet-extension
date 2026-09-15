import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Dev-only: serves dev/test-webapp.html as a real http://localhost origin (so the
// extension's content bridge injects window.arkadeWallet) while resolving
// `@arkade-os/sdk` from local node_modules — the test harness needs the SDK to build
// an escrow VtxoScript + spend PSBT. Run: `npm run test:webapp`.
export default defineConfig({
  root: import.meta.dirname, // serve the dev/ folder
  // Share the extension's root dotenv files and public WXT variables.
  envDir: resolve(import.meta.dirname, '..'),
  envPrefix: ['VITE_', 'WXT_'],
  server: { port: 5174, host: 'localhost', open: '/test-webapp.html' },
  // The SDK ships a clean ESM `module` entry; pre-bundle it so bare imports resolve.
  optimizeDeps: { include: ['@arkade-os/sdk'] },
});
