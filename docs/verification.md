# Verification record

## Local timeout-recovery milestone (2026-10-10; unpublished)

Final checks ran from the integrated ZephyrusG16 project with the working `.venv-repair` and existing frontend dependencies. No dependencies were installed or upgraded. This milestone performed no GitHub operations, publication, deployment or hackathon submission. The earlier published milestone is recorded separately below.

| Check | Exact command | Final result |
| --- | --- | --- |
| Backend, from `backend` | `.\.venv-repair\Scripts\python.exe -m pytest -p no:cacheprovider tests -q --tb=short --basetemp $recoveryTestTemp` | **72 passed** in 4.30 seconds; one upstream Starlette/AnyIO deprecation warning. |
| Frontend units, from `frontend` | `npm test` | **39 passed**, zero failures. |
| TypeScript | `npm run typecheck` | Passed. |
| Production build | `npm run build` | Passed with Vite 6.4.3, 35 modules. |
| Browser installation path | `node scripts/run-e2e.mjs --install-browser --dry-run` | Passed; install and run use the same project browser cache. No download occurred. |
| Final desktop/mobile browser suite | `node scripts/run-e2e.mjs --output "$env:TEMP\return-companion-recovery-e2e-final-20261010"` | **40 passed** in 1.3 minutes, zero failures/retries. |

Backend execution set `RETURN_COMPANION_MODEL_PROVIDER=fake`, `PYTHONDONTWRITEBYTECODE=1`, and `RETURN_COMPANION_DB` to a disposable bootstrap path under the system temporary directory. `$recoveryTestTemp` was `Join-Path $env:TEMP ('return-companion-recovery-final-pytest-' + [Guid]::NewGuid().ToString('N'))`. This explicit new directory avoids the existing pytest temporary-folder permissions conflict. Tests independently patch database paths to temporary files.

Browser execution set `RETURN_COMPANION_E2E_PYTHON` to `(Resolve-Path ..\backend\.venv-repair\Scripts\python.exe).Path`. Playwright starts independent loopback services on 8011/5174 with a fresh temporary SQLite database, forces the fake provider, and uses a test-only 2-second request deadline. Production deadlines remain 10 seconds for REST, 65 seconds for guide selection and 20 seconds for complete MCP operations. The browser suite terminated its services after verification.

Coverage includes complete-body/SSE deadlines, ignored transport cancellation, late rejections, stale scope completion, out-of-order chat and case responses, read retry, synchronous repeated clicks, cancellation before tool dispatch, navigation/reload, lost committed proposal/approval/submission responses, HTTP 500 after commitment, unchanged reads retaining uncertainty, exact same-key proposal replay, malformed successful acknowledgements, an explicitly missing receipt date, blocked/corrupt storage, and exact purchase/case/approval matching. Existing intent, policy, approval, MCP, three-design, keyboard, mock-label and saved-case tests remain passing. No mutation or chat retries happen automatically.

Visual review inspected the final recovery panels in Quiet Ledger, Return Observatory and Field Notes at desktop 1440px and mobile 390px. All six panels have readable labels, wrapped identity text and reachable controls. Browser assertions check viewport overflow in all designs plus recovery text/control contrast of at least 4.5:1; existing approved-state contrast checks also pass. Screenshots and failure traces remain temporary QA artifacts, separate from the design gallery.

Review corrections included unreadable journal overwrite prevention, rejection of missing approval fields, proof of offer replacement before clearing recovery, validation of saved proposal evidence including explicit null dates, and submitted-response simulation/terms checks. The first backend attempt passed 49 tests and hit 23 setup errors in the existing pytest temporary directory; the fresh-directory rerun passed all 72. The first browser run was interrupted to restore the established busy-control behavior and correct recovery test selectors/expectations. The next staged suite passed all 38 checks; final additional missing-date and contrast coverage passed all 40 checks from the main project. An early typecheck during an incomplete delegated file edit was rerun after integration and passed.

Preservation: SHA256 hashes of the existing `cases.sqlite3`, `cases.sqlite3-wal` and `cases.sqlite3-shm` are unchanged after final verification. All original source hashes were checked before selectively integrating 23 source/documentation files; the original release snapshot, ZIP, environments and other projects were preserved. A separate recovery baseline, source-only patch and manifest record this local delta. The project itself remains outside a Git checkout.

Verification gaps: no lint command is configured, so lint was not run. No full screen-reader audit, Linux/macOS run, fresh dependency/browser installation or optional Ollama verification was performed. The existing Starlette/AnyIO deprecation and Node `NO_COLOR`/`FORCE_COLOR` warnings remain. There are no remaining setup permission blockers.

See [request recovery and orchestration](request-recovery.md) and the README for working existing-machine launch steps and separate fresh-checkout setup.

## Previous overnight milestone (2026-10-10; subsequently published as af443f6)

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

