import { defineConfig } from 'vite';

// Dev-only: serves dev/test-webapp.html as a real http://localhost origin (so the
// extension's content bridge injects window.arkadeWallet) while resolving
// `@arkade-os/sdk` from local node_modules — the test harness needs the SDK to build
// an escrow VtxoScript + spend PSBT. Run: `npm run test:webapp`.
export default defineConfig({
  root: import.meta.dirname, // serve the dev/ folder
  server: { port: 5174, host: 'localhost', open: '/test-webapp.html' },
  // The SDK ships a clean ESM `module` entry; pre-bundle it so bare imports resolve.
  optimizeDeps: { include: ['@arkade-os/sdk'] },
});
