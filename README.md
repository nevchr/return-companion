# Return Companion

Return Companion is a local demonstration for a fictional Northstar store. It walks a synthetic headphone purchase through receipt review, a deterministic policy check, a saved proposal, explicit approval, a simulated return, an invalid demo label, and a persistent case timeline.

> **SIMULATION — DEMO ONLY.** Nothing connects to Amazon or another retailer. No real return, refund, postage, or shipping label is created. All orders and receipts are fictional.

## Three visual versions

Use the selector at the top of the app to switch between:

- **Quiet Ledger** — restrained, paper-like surfaces and serif headings.
- **Return Observatory** — a bold night-sky canvas and asymmetric dashboard layout.
- **Field Notes** — a balanced two-column layout with cobalt accents and a compact progress strip.

The selector works with keyboard arrows and remembers its choice in this browser. All versions share the same data, policy, approvals, and case history.

See [the design gallery](docs/designs.md) for desktop screenshots of all three directions.

## Requirements

- Python 3.11 or newer
- Node.js 20 or newer and npm
- No credentials, retailer account, paid service, or cloud configuration

## Launch the existing project on ZephyrusG16

From the existing project root, start the API in one PowerShell terminal:

```powershell
cd backend
$env:RETURN_COMPANION_MODEL_PROVIDER = "fake"
.\.venv-repair\Scripts\python.exe -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

In a second terminal from the project root:

```powershell
cd frontend
npm run dev -- --host 127.0.0.1
```

Open the address Vite prints, normally `http://127.0.0.1:5173`. Stop both servers with Ctrl+C. This existing machine's `.venv` points to an inaccessible WindowsApps Python and is unusable; `.venv-repair` is the working environment. Keep both environments and the case database intact. The commands below are for a fresh checkout.

## Fresh checkout setup on Windows PowerShell

From the project root, create the local Python environment and install the pinned packages:

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.lock
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

In a second terminal from the project root, install the frontend packages and start the UI:

```powershell
cd frontend
npm ci
npm run dev -- --host 127.0.0.1
```

Open the local address printed by Vite (normally `http://127.0.0.1:5173`). Stop the API and UI with Ctrl+C. The local case database is created at `backend/data/cases.sqlite3` and is ignored by Git. Keep it to preserve local cases; do not publish it.

## Try the assistant and return flow

1. Choose `NS-DEMO-1001`, review the synthetic receipt, and confirm the accessories.
2. In the guide panel, ask **“Prepare a return proposal for this sample order.”** The deterministic fake selects `prepare_return_proposal`; the browser sends that call over MCP to the local Python service. The tool stores a proposal and terms in SQLite, but does not submit a return.
3. Review the policy result and exact option. Tick the approval box and choose **Approve this option**.
4. Choose **Confirm simulated return**, or ask the guide **"Please submit the approved return."** Python checks the current server-stored approval, case revision, exact offer, expiry, idempotency key, and unique sample item before the browser calls `submit_simulated_return` over MCP.
5. Reopen the saved case to see its status, history, instructions, and conspicuously invalid demo label.

You can also use **Check return options** to have the same MCP proposal tool prepare a persisted offer. Requests such as "Can I return this?" use the read-only policy tool. The guide cannot approve. After you approve current terms, the submit tool becomes available only for an explicit confirmation such as **"Please submit the approved return."** The API reads the saved approval, checks the offer and expiry, and supplies the submission arguments; the browser then calls that tool over MCP. Each tool call and its structured result appear in the guide panel.

The deterministic fake is the default and makes no model call. A local Ollama model is optional: see [local model and tool flow](docs/model-and-tools.md) for the exact setup and boundaries. Model-selected tool arguments and model prose do not control Python policy facts or approval state.

Chat mutations accept a complete present imperative with a direct return target. Questions, negations, conditional/deferred commands and quotations stay read only. For example, "Send return instructions", "Submit the approved return?" and "Submit the approved return tomorrow" do not submit. Use the button or the exact command above when ready. To choose another option after approval, refresh the offer and approve its new terms. Changing purchases clears the displayed workflow; the original case stays saved.

## Data and safety boundaries

- Only the checked-in Northstar synthetic receipt fixtures are loaded; there is no upload path.
- The delivery-date field for `NS-DEMO-1003` is intentionally missing until a user verifies and enters a date from the sample fixture.
- Python owns eligibility, deadlines, fees, signed offer terms, approval expiry, gated tool availability, submission arguments, and SQLite transitions.
- MCP offers sample lookup, policy lookup, proposal preparation, and approval-gated simulated submission. Unknown tools and extra arguments are rejected.
- The submission tool is idempotent and cannot move money, issue postage, or contact a merchant.

## Tests and browser verification

For the existing ZephyrusG16 project:

```powershell
cd backend
.\.venv-repair\Scripts\python.exe -m pytest -p no:cacheprovider tests -q --tb=short
cd ..\frontend
npm test
npm run typecheck
npm run build
$env:RETURN_COMPANION_E2E_PYTHON = (Resolve-Path ..\backend\.venv-repair\Scripts\python.exe).Path
npm run test:e2e
```

The browser suite starts separate loopback API/UI servers, forces the deterministic fake provider, and uses a fresh temporary database. It checks all three visual versions on desktop and mobile, keyboard switching, an error and retry, MCP proposal preparation, exact approval, simulated submission, saved-case recovery, purchase/approval consistency, cancellation, late responses and uncertain mutation outcomes. For a fresh checkout, use its `.venv` in the test commands and run `npm run setup:browser` once from `frontend` to install Chromium into the same project-local `.playwright-browsers` folder used by the runner. Browser downloads are free; they are not required to run the app. A custom backend interpreter can be selected with `$env:RETURN_COMPANION_E2E_PYTHON = "C:\path\to\python.exe"`. The runner prefers the existing `.venv-repair` when available, with standard `.venv` candidates on Windows and Linux/macOS.

See [architecture](docs/architecture.md), [workflow and contributor guide](docs/workflow.md), [API and MCP contract](contracts/api.md), [demo outline](docs/demo-script.md), and [current hackathon requirements](docs/hackathon-requirements.md).

See [local overnight readiness](docs/overnight-readiness.md) for the latest reliability fixes, orchestration notes, verification gaps, and launch commands for the existing environment on this machine.

## Request cancellation and recovery

Requests have a bounded deadline and a **Cancel request** control. Cancellation stops waiting and prevents later steps from that action. It cannot undo a write the local API has already accepted. If a write's outcome is uncertain, **Outcome unconfirmed** blocks new changes, including guide requests, until saved progress confirms the original operation for its exact purchase and case. Read recovery never submits a return.

An interrupted proposal can be explicitly retrieved using **Retry same reviewed proposal**, which reuses its original evidence and idempotency key. No write or chat request is retried automatically. The recovery record survives a reload in this browser tab's session storage. See [request recovery and verification boundaries](docs/request-recovery.md).

## Project status

This is a local hackathon concept, not a production service or an Amazon/Alexa+ integration. No accounts, real purchase data, retailer API, notification service, deployment, or video are included.

The approval/workflow milestone was published separately as commit `af443f6`. The timeout-recovery milestone is new local work and has not been published or deployed.

