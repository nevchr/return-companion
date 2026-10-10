import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const frontendDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = resolve(frontendDir, 'node_modules/@playwright/test/cli.js');
const args = process.argv.slice(2);
const command = args[0] === '--install-browser'
  ? ['install', 'chromium', ...args.slice(1)]
  : ['test', ...args];
const result = spawnSync(process.execPath, [cli, ...command], {
  cwd: frontendDir,
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: resolve(frontendDir, '.playwright-browsers') },
  stdio: 'inherit',
});
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
