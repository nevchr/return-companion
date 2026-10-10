# Local model and MCP tool flow

## Deterministic default

The default provider is `deterministic_fake_tool_simulation`. It makes no model call and deterministically selects sample lookup, policy check, or persisted proposal preparation when the user explicitly asks to prepare/start a return. A fourth tool, simulated submission, is available only after Python verifies saved approval and a present imperative confirmation. Tool arguments are built from validated synthetic evidence and saved state by Python.

## Optional local Ollama

Use an already installed local Ollama service if you want the tool-selection step to use a local language model. No key, cloud endpoint, or account is used.

1. Install Ollama using its own local installation instructions.
2. In a local PowerShell terminal, download a model once and ensure Ollama is serving on loopback:

   ```powershell
   ollama pull qwen3:4b
   ollama serve
   ```

3. In the separate API terminal, select that provider before starting FastAPI:

   ```powershell
   $env:RETURN_COMPANION_MODEL_PROVIDER = "ollama"
   $env:OLLAMA_MODEL = "qwen3:4b"
   $env:OLLAMA_BASE_URL = "http://127.0.0.1:11434"
   ```

4. Start the frontend and use the guide panel. Its status names the selected provider, and the MCP tool trace shows the exact selected tool and structured Python result.
5. To return to the reproducible default, stop and restart FastAPI with `RETURN_COMPANION_MODEL_PROVIDER=fake`, or remove the provider variable.

The application refuses non-loopback Ollama URLs, disables environment-proxy use, and bounds the request time. A local model may choose only an allowlisted tool. Its arguments and generated prose are discarded. Python validates the evidence and owns eligibility, deadlines, fees, terms, approval expiry, case state and duplicate prevention. If the model is unavailable or returns an unsupported tool selection, the deterministic fake is used.

## Preparing a proposal

Ask **“Prepare a return proposal for this sample order.”** The app checks that the synthetic receipt has been reviewed, then the browser calls `prepare_return_proposal` over MCP. Python stores the evidence snapshot, deterministic eligibility, signed options and an event in SQLite. A proposal is not a submitted return. Replaying a proposal call with the same idempotency key returns the same case; reusing that key for different evidence is rejected.

## Explicit approval and simulation

Select an exact option, tick the approval checkbox and choose **Approve this option**. The API verifies the active offer ID, terms hash, case revision and expiry before persisting the approval. Then use **Confirm simulated return**, or ask **"Please submit the approved return."** Python verifies the approval before supplying the MCP arguments, and the MCP handler checks expiry, revision, offer, idempotency key and unique sample item again before recording `AWAITING_DROPOFF`. No retailer, payment system, carrier, or shipping label is contacted.

The shared deterministic intent gate requires a complete present command with a direct target. It rejects questions, negations, quotations, conditions, deferred actions and extra clauses. "Send return instructions" and "Confirm the deadline for my return" cannot become submission consent, even if a model selects the submission tool. Conservative wording may leave other phrasing read only; use the documented commands or the button. A model still cannot approve or override policy facts.

Reviewed evidence remains locked to the saved proposal. An approved option stays selected until the user refreshes the offer and approves new terms. Switching purchases clears displayed case, approval and conversation state without deleting saved cases. Controls that change evidence or case selection are disabled during an in-flight workflow action.
