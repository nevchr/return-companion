# Local API contract

The Vite development server proxies `/api/*` and `/mcp` to the loopback FastAPI service on port 8000. Python owns policy facts, eligibility, approval checks, expiry, and simulation state. The UI displays the returned facts and labels all simulated output.

| Method and path | Purpose |
| --- | --- |
| `GET /api/health` | Local service and provider status |
| `GET /api/demo` | Synthetic orders, parsed receipt fixtures, saved cases, fixture date, and policy version |
| `POST /api/chat` | Fake-default or optional loopback Ollama intent selection; Python validates explicit proposal intent and constructs tool arguments |
| `POST /mcp` | MCP 2025-11-25 Streamable HTTP endpoint for initialization, tool discovery, and tool calls |
| `POST /api/cases` | Create a draft after explicit review of a known synthetic receipt |
| `POST /api/cases/{id}/offers` | Deterministically evaluate the saved evidence and prepare signed terms |
| `POST /api/cases/{id}/approve` | Approve the exact offer, terms hash, and case revision |
| `POST /api/cases/{id}/submit` | Simulate one approved return; idempotent by key and unique by sample order item |
| `GET /api/cases/{id}` | Reopen persistent case and event timeline |
| `GET /api/cases/{id}/label` | Download plain-text label that is explicitly invalid for shipping |
| `POST /api/demo/cases/{id}/advance` | Demo-only status progression through synthetic drop-off, receipt, and refund statuses |

## MCP tools

`tools/list` exposes four synthetic tools:

- `get_sample_order` returns one known synthetic order.
- `check_return_options` evaluates saved facts using the deterministic policy.
- `prepare_return_proposal` requires explicit receipt review, validated evidence, and an idempotency key. It creates or reuses a local draft and its policy offer. Reusing a key with different inputs is rejected.
- `submit_simulated_return` requires a persisted server-issued approval ID and an idempotency key. It routes through the same checks as the UI and can only create a simulated return. The model selector never receives this tool; the browser invokes it only after the person approves the displayed terms.

The browser MCP client initializes, sends `notifications/initialized`, calls `tools/list`, then calls the selected tool over Streamable HTTP. It negotiates version `2025-11-25`, requests JSON or SSE, sends `MCP-Protocol-Version` after initialization, and handles JSON and SSE results. The server is stateless, omits `MCP-Session-Id`, and returns HTTP 202 for accepted notifications. Origin checks permit loopback web origins only.

## Chat and evidence

`POST /api/chat` takes a required message and synthetic order ID, plus optional case ID, issue, condition, accessories confirmation, receipt-reviewed flag, delivery-date override, and up to 16 prior user/assistant text turns. The deterministic fake is the default. Optional Ollama uses only a loopback URL with a bounded request. Model output is an intent selection: model-generated arguments and prose are ignored. Python builds tool arguments from validated fields and saved state. A proposal intent is honored only when the user's message explicitly asks to start or prepare a return/case/request and the receipt has been marked reviewed. A submit intent must be an explicit imperative; the API exposes `submit_simulated_return` only when the case ID belongs to the requested sample order and the saved approval still matches the current offer, revision, and expiry. Without current approval the response has no tool call. For a valid request, the server supplies the persisted approval ID and deterministic idempotency key. `model_can_approve` remains false; `submit_tool_available_after_server_verified_user_approval` describes the gated handoff.

All request schemas reject unexpected fields. Offer terms are hashed server-side. Submission requires an unexpired approval for the current case revision and selected option. SQLite enforces idempotency and a unique retailer/order/item key so a second key cannot return the same sample item again. Refreshing an offer replaces its ID and clears the approval.

Receipt fixtures are checked-in synthetic text parsed locally into display-only fields. There is no upload endpoint or access to user files. Missing receipt facts remain missing; Python returns review instead of inferring them. Delivery date is the only editable extracted field, and a user-confirmed edit is saved in the evidence snapshot used by policy.

The deterministic fake is free and local. Ollama is an optional user-installed local provider; no model download is required by the project. `REFUNDED` and all other lifecycle labels describe synthetic demo status only. This is an Alexa+ agent interaction simulation, not an Amazon or Alexa+ service integration.

