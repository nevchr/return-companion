# Under-three-minute demo outline (2:40)

Use the local default provider and the synthetic `NS-DEMO-1001` order. Do not present this as a production Alexa+ integration.

- **0:00–0:15 — Boundary and design choice:** Say the store, order, return and label are fictional. Show the SIMULATION marker and briefly switch from Quiet Ledger to Return Observatory to Field Notes.
- **0:15–0:35 — Receipt:** Select the synthetic wireless headphones. Expand the sample receipt, confirm it was reviewed, and confirm the required accessories.
- **0:35–1:00 — Assistant contribution:** Ask “Prepare a return proposal for this sample order.” Show the deterministic fake provider, actual MCP Streamable HTTP trace, `prepare_return_proposal` and its persisted case/offer result. State that the proposal has not been submitted.
- **1:00–1:30 — Policy and terms:** Show the Python policy result, options, refund estimate, method, fee, clause and deadline. Select one option.
- **1:30–1:50 — Approval gate:** Tick the exact-terms approval and press **Approve this option**. Point out that approval and case revision are saved server-side.
- **1:50–2:15 — Simulated action:** Press **Confirm simulated return**. Show `submit_simulated_return`, the approval-bound response, saved status and “DEMO ONLY - NOT VALID FOR SHIPPING”. Say no retailer, carrier or payment service was called.
- **2:15–2:35 — Recovery and edge:** Reopen the saved case. If time remains, show the missing-date sample pausing for receipt review.
- **2:35–2:40 — Close:** Restate that the runnable local app demonstrates an assistant-mediated, explicit-consent return proposal and simulated workflow.

## Capture checklist

Show the page running locally in the browser, the provider label, MCP tool names and results, policy/approval information, simulation labels and persistence. Avoid real account data and unrelated desktop content. Keep the exported video under three minutes and upload it only when the project owner is ready to submit.