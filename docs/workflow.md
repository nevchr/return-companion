# Development workflow

## Project boundaries

- `fixtures/` contains fictional Northstar orders, policy and sample receipts.
- `backend/app/policy.py` is the pure policy engine. `backend/app/main.py` validates requests, stores proposals, enforces approvals, and owns the MCP server.
- `frontend/src/` is one React application with three visual skins. The selector changes layout and styling only; all versions use the same workflow state and API.
- `backend/tests/` and `frontend/tests/` cover policy/API/protocol/client behavior. `frontend/e2e/` exercises the browser against temporary SQLite data.

## Change workflow

1. Read `contracts/api.md` and the relevant acceptance notes before changing an interface.
2. Keep facts and state transitions on the Python side. Use synthetic fixtures and an isolated database for tests.
3. When editing MCP tools, update their schemas, strict argument checks, the browser allowlist and tests together. Proposal preparation is explicit and idempotent. Submission requires the server-stored approval for the current revision and an unexpired exact offer.
4. Keep UI-only changes inside the visual skins when possible. Preserve labels, keyboard behavior, error roles and shared workflow controls across all versions.
5. Run the backend tests, frontend unit tests, type check, build and browser suite after changes. Record the commands and results in `docs/verification.md`.
6. Review the release file list before publishing. Exclude databases, virtual environments, browser binaries, caches, logs, screenshots containing local identifiers, credentials and local machine paths.

## Local model

The default selector is deterministic and needs no model. The optional Ollama adapter connects only to loopback. It selects a bounded tool name; Python supplies validated arguments and computes every policy fact. The model cannot approve a proposal. For an explicit confirmation, Python exposes the submit tool only after checking the saved, current, unexpired approval, and then supplies the submission arguments. The MCP handler rechecks those facts before recording a simulated return.

## Local data

Cases persist in `backend/data/cases.sqlite3`. Tests and browser runs must point to temporary SQLite databases. Do not reset the local database as part of testing.
