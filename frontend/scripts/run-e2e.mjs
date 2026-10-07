import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const frontendDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = resolve(frontendDir, 'node_modules/@playwright/test/cli.js');
const result = spawnSync(process.execPath, [cli, 'test', ...process.argv.slice(2)], {
  cwd: frontendDir,
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: resolve(frontendDir, '.playwright-browsers') },
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
