import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const profileRoot = resolve(import.meta.dirname, '..', '.dev-browser-profiles');

await Promise.all([
  mkdir(resolve(profileRoot, 'chrome'), { recursive: true }),
  mkdir(resolve(profileRoot, 'firefox'), { recursive: true }),
]);
