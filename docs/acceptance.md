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
| Simulated submission through MCP | Implemented | `submit_simulated_return` needs the persisted approval ID; Python rechecks policy state and idempotency. The guide receives it only after server-verified approval and an explicit present confirmation. |
| Label, instructions, persistent status | Implemented | Downloaded label says invalid for shipping; saved case can be reopened from SQLite. |
| Alexa+ simulation track | Implemented as an agent interaction simulation | The fake selector is the default. Optional loopback-only Ollama can select a tool, but cannot supply policy arguments, approve, or bypass the submission gate. No Amazon service integration is claimed. |
| Purchase and approval consistency | Implemented | Selecting a different purchase clears the displayed case and approval; saved evidence and approved options are locked. An older case keeps its identity on refresh. |
| Tests, build, and visual review | Recorded in verification notes | See `verification.md` for exact commands, results and gaps. |

## Hackathon items outside this local build

The event still requires its own registration/submission, a public source URL, a demo video under three minutes, and tool feedback. Source publication was completed separately; this overnight milestone remains local and unpublished. No hackathon submission, hosting, deployment or video was performed during this milestone. See `hackathon-requirements.md` for the previously recorded official links and dates; event requirements were not rechecked during this local engineering work.
