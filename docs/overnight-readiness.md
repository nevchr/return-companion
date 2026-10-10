# Overnight local readiness milestone

Date: 2026-10-10. This milestone is local and unpublished. All purchases, policy, approvals, returns, labels and lifecycle events remain synthetic. No accounts, credentials, paid services, retailer requests, video, deployment or hackathon submission were used.

## Starting state and scope

The main project matched the saved release source: no user source changes needed to be merged. The isolated unfinished work contained only new regression cases in `backend/tests/test_agent.py` and `backend/tests/test_api.py`. All 17 new cases initially failed. They showed that advice, questions, negations and deferred commands could select a mutation.

The project directory itself is not a Git checkout. The separate release snapshot has an unborn Git index with its 53 source files staged. That index and the release ZIP were preserved. Source comparisons used the saved per-file checksums; updates were limited to the milestone files. The existing SQLite database and its journal files were preserved and checked by hash after the tests.

## What changed

- One shared Python gate recognizes complete present imperatives for proposal preparation and submission. Questions, quotations, negations, conditional/deferred requests and extra clauses stay read only. Model tool selection cannot bypass that gate or the existing saved-approval checks.
- Switching purchases clears the displayed case, options, approval and conversation. Clicking the already selected purchase preserves reviewed evidence. Saved cases remain available to reopen.
- Reviewed evidence stays with its saved proposal. Approved options are locked until the offer is refreshed and approved again. Case/evidence controls are disabled during workflow requests. A failed offer refresh preserves the still-saved approval.
- Refresh matches a defined case identifier and restores the same case's evidence, options and approval together. It no longer treats two absent fallback IDs as a match and silently selects the newest case.
- Return Observatory keeps its existing layout and colors, with readable prices, receipt-review text and confirmation guidance. Browser regressions require at least 4.5:1 text contrast for those fields.
- `npm run setup:browser` installs Chromium into the same project folder used by the browser runner. Playwright detects standard Windows and Linux/macOS virtual environments, forces the fake provider, and continues to use a fresh temporary SQLite database. The already resolved Playwright version is pinned; no dependency upgrade was performed.

Quiet Ledger, Return Observatory and Field Notes remain selectable. No final design was chosen.

## Development orchestration

The coordinator owned implementation, regression tests, setup and documentation. A small task was delegated to a Sol 6.1 High reviewer with read-only ownership of the milestone files. The reviewer found the undefined-case-ID refresh defect, which was integrated with a regression that opens an older case after creating a newer one. A follow-up review found no further actionable defects. The reviewer made no file edits and did not start services or access external systems.

This is a useful pattern for the next task:

1. Capture the current source diff and preserve user changes.
2. Pick a concrete defect and write an isolated regression first.
3. Give a reviewer explicit read-only ownership while the coordinator implements.
4. Integrate the finding, then run tests against disposable data.
5. Record exact commands, failures corrected, final results and verification gaps.

## Run locally on this machine

The existing `.venv` interpreter is unusable on this machine because it references an inaccessible WindowsApps Python executable. This milestone reused the existing working `.venv-repair` without deleting or replacing either environment.

From the project root, use one terminal for the API:

```powershell
cd backend
.\.venv-repair\Scripts\python.exe -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

In a second terminal from the project root:

```powershell
cd frontend
npm run dev -- --host 127.0.0.1
```

Open the address Vite prints, normally `http://127.0.0.1:5173`. Stop both servers with Ctrl+C. For a fresh checkout, follow the standard `.venv` and `npm ci` instructions in the README.

For browser tests on this existing machine:

```powershell
cd frontend
$env:RETURN_COMPANION_E2E_PYTHON = (Resolve-Path ..\backend\.venv-repair\Scripts\python.exe).Path
npm run test:e2e
```

The suite uses separate loopback ports 8011 and 5174 and a disposable database. Do not reset the saved user case database to rerun it.

## Evidence and next review item

See [verification](verification.md) for final commands and results. Browser screenshots and traces are temporary QA artifacts, separate from the three existing design-gallery screenshots.

The shared `contracts/api.md` has an older sentence saying the model selector never receives submission, while its later chat section describes the current approval-gated capability correctly. It was left unchanged under AGENTS.md's coordinator rule for shared contracts. The next documentation review should align that sentence. A later reliability milestone can add bounded REST request timeouts and a recovery regression; MCP calls already have a timeout, but the plain REST fetch wrapper does not.
