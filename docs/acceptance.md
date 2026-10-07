# Return Companion acceptance checklist

Scope: synthetic Northstar purchase evidence → deterministic policy result → explicit approval → idempotent simulated return → invalid mock label and instructions → saved case recovery. The project stays local and free. It uses no retailer API, inbox data, live return, refund, postage, account credentials, deployment, or publishing. Model wording cannot change policy facts or act without approval.

## Current local build

| Acceptance item | Status | Evidence |
| --- | --- | --- |
| Synthetic Northstar order and deterministic policy | Implemented | `fixtures/orders.json`, `fixtures/northstar-policy-v1.json`, `backend/app/policy.py`, and policy boundary tests. |
| Receipt review and delivery-date correction | Implemented for bundled fixtures | The user reviews synthetic receipt text before proposal; missing dates remain missing and trigger review. |
| Eligibility, deadline, fees, and return options | Implemented | Python policy is authoritative and supplies structured MCP facts. |
| Three selectable UI directions | Implemented | Quiet Ledger, Return Observatory, and Field Notes; a native radio group supports keyboard selection and remembers the local choice. |
| MCP-assisted proposal preparation | Implemented | `prepare_return_proposal` checks reviewed evidence and idempotency before creating/reusing a local case and offer. |
| Explicit approval | Implemented | Separate approval action binds offer ID, terms hash, revision, and expiry. |
| Simulated submission through MCP | Implemented | `submit_simulated_return` needs the persisted approval ID; Python rechecks policy state and idempotency. The model cannot call it. |
| Label, instructions, persistent status | Implemented | Downloaded label says invalid for shipping; saved case can be reopened from SQLite. |
| Alexa+ simulation track | Implemented as an agent interaction simulation | The fake selector is the default. Optional loopback-only Ollama can select a tool, but cannot supply policy arguments, approve, or submit. No Amazon service integration is claimed. |
| Tests, build, and visual review | To be recorded for this revision | See `verification.md` after the final local checks. |

## Hackathon items outside this local build

The event still requires its own registration/submission, a public source URL, a demo video under three minutes, and tool feedback. The public source release is prepared locally, but creation of a new public GitHub repository depends on an available repository-create route. The project has not been submitted, hosted, or deployed. See `hackathon-requirements.md` for official links and current dates.
