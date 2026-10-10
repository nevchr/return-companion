# Local request recovery

This timeout-recovery milestone is local and unpublished. The earlier approval/workflow milestone was published separately as `af443f6`. This work uses synthetic Northstar data and the deterministic fake. It does not access GitHub, retailers, real accounts, inboxes, paid models or the homelab.

## What the controls mean

- **Cancel request** stops waiting, invalidates the action and prevents its later responses from changing the current view or dispatching another tool. It cannot undo a request already accepted by the local API.
- **Retry loading** repeats read operations only. Chat selection is not retried.
- **Outcome unconfirmed** means a dispatched write has no trusted acknowledgement. The original purchase, case and frozen arguments remain in this tab's session storage. New writes and guide requests are blocked across purchase/case switching.
- **Check saved progress** reads the original case and checks exact purchase/case identity plus the operation's offer, revision or approval facts. An unchanged record is not proof that an in-flight write failed. The pending record stays until the operation is verified.
- **Retry same reviewed proposal** is an explicit user action that retrieves an interrupted proposal with its original evidence and original idempotency key. It never creates a fresh retry key or approves/submits a return. The server either replays that saved proposal or reports it is still in progress.
- **Recovery unavailable** blocks writes when the stored journal cannot be read or validated. **Retry recovery storage** reads it again; it never discards or overwrites an unresolved action. A valid journal requires real operation identifiers, and missing approval fields never count as a match.

There are no automatic mutation retries. A received validation/conflict rejection (HTTP 4xx) can end recovery; HTTP 5xx, malformed success responses, transport failures and timeouts retain uncertainty. Session-storage failure prevents dispatching a write. Reloading the same tab preserves the record. Clearing browser storage or closing the tab removes this client recovery record; saved SQLite cases remain available to reopen and inspect.

## Deadlines and identity

Production defaults are 10 seconds for ordinary REST operations, 65 seconds for local guide intent selection, and 20 seconds for the complete MCP call including initialization, discovery and body/SSE parsing. Browser regressions use a 2-second test-only Vite override. Requests are aborted on cancellation, navigation and supersession. Scope guards reject stale results even if a transport ignores cancellation. Completion from an older action cannot unlock a newer action.

Python remains the authority for policy, current terms, approvals and idempotent simulation. A model selection cannot bypass approval or change authoritative arguments. Recovery never transfers approval to another purchase or case. Quiet Ledger, Return Observatory and Field Notes retain the same workflow and simulation labels.

## Development orchestration

Small delegated tasks had explicit ownership:

1. The lifecycle agent implemented `requestLifecycle.js`, its declaration and unit tests, then owned App integration and recovery styles.
2. The MCP agent implemented `mcpClient.js`, its declaration and unit tests, then owned the new browser recovery specification.
3. The coordinator owned the REST/journal helpers, their regression tests, existing browser-test integration, shared-contract correction, setup documentation, selective integration, aggregate verification and visual review.

A separate reviewer inspected helpers without file ownership or side effects. The review identified unreadable-journal overwrite risk and a missing-field approval comparison; both were corrected with regressions before integration.

The recovery staging directory and a checksum-based source baseline preserve the previously published work. Integration checks expected source hashes before copying changed files. Tests use temporary SQLite databases; the saved case database and its WAL/SHM files are checked by hash and never reset.

See [workflow](workflow.md) for the repeatable development process, [verification](verification.md) for exact results, and the README for existing-machine and fresh-checkout launch steps. Optional Ollama, a fresh dependency/browser installation, Linux/macOS and a full screen-reader audit require separate verification.
