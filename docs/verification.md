# Verification record

## Current revision (2026-10-06)

- Backend: `.venv-repair\Scripts\python.exe -m pytest -p no:cacheprovider tests -q` - **44 passed**, 1 upstream Starlette/AnyIO deprecation warning.
- Frontend unit tests: `npm test` - **8 passed**.
- Frontend TypeScript check: `npm run typecheck` - passed.
- Frontend production build: `npm run build` - passed with Vite 6.4.3.
- Browser suite: `node scripts\run-e2e.mjs --output <temporary-directory>` with `RETURN_COMPANION_E2E_PYTHON` set to the local backend environment - **4 passed** (desktop and mobile Chromium). Checks all three visual variants, arrow-key switching, MCP policy results, a temporary MCP error and retry, receipt review/correction, proposal preparation, exact approval, assistant-to-MCP simulated submission, invalid label download, and saved-case recovery.
- Visual review: inspected all three designs at desktop (1440px) and mobile (390px). Text and controls stay within the viewport; the selector, simulation notice, receipt, offer, saved case, and MCP trace render. Clean desktop screenshots are included in `docs/screenshots/` and shown in the design gallery.
- Lint: no lint command is configured. Playwright emitted a benign Node `NO_COLOR`/`FORCE_COLOR` warning. Backend emitted one upstream Starlette/AnyIO deprecation warning.

The backend tests and browser suite use isolated temporary databases. Submission guard tests also cover missing approval, expiry, and repeat assistant confirmation. No user case data was modified. No retailer service, postage, payment, cloud model, publishing, or deployment was used.

See `README.md` for setup and repeatable commands. The optional Ollama provider was not required; the deterministic fake remains the default.

