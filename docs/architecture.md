# Architecture

## Runtime path

```mermaid
sequenceDiagram
    actor Person
    participant UI as Browser UI
    participant Chat as FastAPI chat selector
    participant MCP as FastAPI MCP endpoint
    participant Policy as Python policy and state
    participant DB as Local SQLite
    Person->>UI: Ask about order or explicitly request proposal
    UI->>Chat: Message + selected synthetic evidence
    Chat-->>UI: Allowlisted tool name; Python-built arguments
    UI->>MCP: MCP initialize, tools/list, tools/call
    MCP->>Policy: Validate tool arguments and run policy/state operation
    Policy->>DB: Read fixture facts or persist reviewed proposal
    DB-->>Policy: Case and offer snapshot
    Policy-->>UI: Structured result and visible tool trace
    Person->>UI: Review exact offer and explicitly approve
    UI->>Policy: Approval API request with offer, terms hash and revision
    Policy->>DB: Validate offer and expiry; persist approval
    Person->>UI: Confirm simulated return
    UI->>MCP: submit_simulated_return + approval ID + idempotency key
    MCP->>Policy: Validate current server-stored approval and offer
    Policy->>DB: Persist one synthetic return and event
    Policy-->>UI: Simulation status and invalid demo label
```

## Boundaries

The browser uses a real MCP Streamable HTTP exchange (`initialize`, `notifications/initialized`, `tools/list`, and `tools/call`) with the local API. The MCP tool set contains:

- `get_sample_order` and `check_return_options`: read-only synthetic facts.
- `prepare_return_proposal`: creates a persisted local case and offer after explicit receipt review. Replays with the same idempotency key return the same case.
- `submit_simulated_return`: requires a saved approval for the current revision and exact unexpired offer. It routes through the same SQLite-backed idempotent submit function as the HTTP API.

The optional local model normally chooses among sample lookup, policy lookup, and proposal preparation. For an explicit submit command, Python first reads the saved case and verifies the current offer, approval, revision, and expiry. Only then does it expose the submit tool and construct its arguments from the saved approval. The browser calls that tool over MCP, and Python rechecks approval, expiry, uniqueness, and idempotency when it executes. The model cannot create or alter approval or policy facts.

The local SQLite database preserves case evidence, offer terms, approval, simulated return and timeline. All retailer IDs, products, receipts, policy rules and labels are fictional. The demo label is deliberately marked invalid for shipping.

## Visual versions

The React workflow is shared. `data-design` selects `Quiet Ledger`, `Return Observatory` or `Field Notes` styles/layout. The selector persists only the visual preference in browser local storage. It does not change API data or case state.
