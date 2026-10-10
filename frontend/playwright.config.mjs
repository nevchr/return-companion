import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const frontendDir = dirname(fileURLToPath(import.meta.url));
const backendDir = resolve(frontendDir, '../backend');
const isolatedDir = mkdtempSync(join(tmpdir(), 'return-companion-e2e-'));
const databasePath = join(isolatedDir, 'cases.sqlite3');
const candidatePythons = [
  resolve(backendDir, '.venv-repair/Scripts/python.exe'),
  resolve(backendDir, '.venv-repair/bin/python'),
  resolve(backendDir, '.venv/Scripts/python.exe'),
  resolve(backendDir, '.venv/bin/python'),
];
const python = process.env.RETURN_COMPANION_E2E_PYTHON
  ?? candidatePythons.find((candidate) => existsSync(candidate))
  ?? 'python';
const quotedPython = `"${python.replaceAll('"', '\\"')}"`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  outputDir: './test-results',
  use: {
    baseURL: 'http://127.0.0.1:5174',
    browserName: 'chromium',
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 1050 }, deviceScaleFactor: 1 } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true } },
  ],
  webServer: [
    {
      command: `${quotedPython} -m uvicorn app.main:app --host 127.0.0.1 --port 8011`,
      cwd: backendDir,
      url: 'http://127.0.0.1:8011/api/health',
      env: { RETURN_COMPANION_DB: databasePath, RETURN_COMPANION_MODEL_PROVIDER: 'fake' },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'npm run dev -- --host 127.0.0.1 --port 5174 --strictPort',
      cwd: frontendDir,
      url: 'http://127.0.0.1:5174',
      env: { VITE_API_PROXY_TARGET: 'http://127.0.0.1:8011', VITE_REQUEST_TIMEOUT_MS: '2000' },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
