# Verification record

## Local overnight milestone (2026-10-10, unpublished)

Checks ran on Windows in the existing project, using its working `.venv-repair` and installed frontend packages. No dependencies were downloaded or upgraded.

| Check | Exact command | Result |
| --- | --- | --- |
| Backend, from `backend` | `.\.venv-repair\Scripts\python.exe -m pytest -p no:cacheprovider tests -q --tb=short` | **72 passed**; one upstream Starlette/AnyIO deprecation warning. |
| Frontend unit tests, from `frontend` | `npm test` | **8 passed**. |
| TypeScript | `npm run typecheck` | Passed. |
| Final production build | `npm run build` | Passed with Vite 6.4.3 after the final case-refresh and contrast changes. |
| Browser installation path | `npm run setup:browser -- --dry-run` | Passed; all planned browser runtimes use `frontend/.playwright-browsers`, the runner's folder. No download was performed. |
| Final browser suite | `node scripts/run-e2e.mjs --output "$env:TEMP\return-companion-overnight-e2e-contrast-20261010"` | **10 passed** in 23.0 seconds, desktop and mobile Chromium. |

For the final browser command, `RETURN_COMPANION_E2E_PYTHON` selected the existing backend `.venv-repair/Scripts/python.exe`. The parent shell deliberately set `RETURN_COMPANION_MODEL_PROVIDER=ollama`; the Playwright server override still forced the deterministic fake, and the new browser tests asserted that provider via `/api/health`. No Ollama request was used for verification.

New coverage includes advice/question/negation/deferred/conditional mutation refusal despite an overeager selector; positive documented imperatives; read-only advice after approval; button and typed MCP confirmation; busy controls; selected-purchase preservation; switching purchases; locked evidence and approved options; failed-refresh approval recovery; new-proposal approval clearing; and older-case identity after refresh. Six focused contrast checks require at least 4.5:1 on Return Observatory's prices, receipt-review label, offer-refresh guidance and confirmation text. The three designs fit the tested desktop/mobile viewports in their approved state.

Visual review inspected all three approved designs at 1440px and 390px. It identified low-contrast dark-design text, which was corrected and rechecked in final desktop/mobile option screenshots. Existing design-gallery images were preserved. New QA screenshots and traces stayed in temporary output folders.

Initial regression reproduction: **17 failures** before implementing the intent gate. The first expanded browser run had **4 passes and 6 failures** because the new test looked up the confirmation button's idle text while its busy text was displayed. The test now targets the button in the confirmation panel during a held request. After that correction and the reviewed older-case fix, the complete suite passed, then passed again after adding the contrast checks.

Preservation check: SHA256 hashes of the existing `cases.sqlite3`, `cases.sqlite3-wal` and `cases.sqlite3-shm` were unchanged after final verification. Backend and browser tests used temporary databases. Target source files were checked before selective updates; the original release snapshot and ZIP stayed untouched.

Verification gaps: no lint command is configured; no full screen-reader/accessibility audit was run; Linux/macOS interpreter discovery and a fresh browser download were not executed on this Windows machine. Optional Ollama was not exercised. Playwright emitted the existing Node `NO_COLOR`/`FORCE_COLOR` warning. There was no publishing, deployment, video or hackathon submission during this milestone.

See [overnight readiness and orchestration notes](overnight-readiness.md) for local launch steps, file ownership and the next bounded review items.

## Previous revision (2026-10-06)

- Backend: `.venv-repair\Scripts\python.exe -m pytest -p no:cacheprovider tests -q` - **44 passed**, 1 upstream Starlette/AnyIO deprecation warning.
- Frontend unit tests: `npm test` - **8 passed**.
- Frontend TypeScript check: `npm run typecheck` - passed.
- Frontend production build: `npm run build` - passed with Vite 6.4.3.
- Browser suite: `node scripts\run-e2e.mjs --output <temporary-directory>` with `RETURN_COMPANION_E2E_PYTHON` set to the local backend environment - **4 passed** (desktop and mobile Chromium). Checks all three visual variants, arrow-key switching, MCP policy results, a temporary MCP error and retry, receipt review/correction, proposal preparation, exact approval, assistant-to-MCP simulated submission, invalid label download, and saved-case recovery.
- Visual review: inspected all three designs at desktop (1440px) and mobile (390px). Text and controls stay within the viewport; the selector, simulation notice, receipt, offer, saved case, and MCP trace render. Clean desktop screenshots are included in `docs/screenshots/` and shown in the design gallery.
- Lint: no lint command is configured. Playwright emitted a benign Node `NO_COLOR`/`FORCE_COLOR` warning. Backend emitted one upstream Starlette/AnyIO deprecation warning.

The backend tests and browser suite use isolated temporary databases. Submission guard tests also cover missing approval, expiry, and repeat assistant confirmation. No user case data was modified. No retailer service, postage, payment, cloud model, publishing, or deployment was used.

See `README.md` for setup and repeatable commands. The optional Ollama provider was not required; the deterministic fake remains the default.

