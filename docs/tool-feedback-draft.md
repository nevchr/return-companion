# Product and tool feedback draft

This draft reflects the project work completed through October 6, 2026. It is not a submitted review. Keep or revise it after the final demo; do not describe a product as tested when it was not used.

## MCP Streamable HTTP and local server path

**Used for:** The browser-to-loopback-server transport. The client sends `initialize`, `notifications/initialized`, `tools/list` and `tools/call`; the server returns structured synthetic policy/case results.

**What worked:** The protocol gives the demo an observable, standards-based tool path instead of a front-end-only mock. Listing a minimal tool set and inspecting structured results made it easy to show exactly which local action ran. Local transport kept the walkthrough reproducible without an account or hosted service.

**What could improve:** A first-time implementer must coordinate version negotiation, required headers, JSON/SSE response parsing, Origin checks, cancellation, argument schemas and tool errors. A small, current end-to-end “hello tool” example that includes browser initialization and a local server would reduce that integration friction. The demo covers JSON and SSE response parsing, though the server currently emits JSON.

**Onboarding:** Read the current Streamable HTTP transport specification, start the local FastAPI server, initialize from the browser, discover the tools and call a synthetic lookup. No credentials are required here.

**Build again?** Yes, for a locally runnable assistant demo where a reviewer can inspect the tool boundary and structured result without provisioning a cloud account.

## FastAPI / Python policy and persistence

**Used for:** Deterministic eligibility, terms hashing, receipt evidence snapshots, persisted offers and approvals, expiry/revision checks and idempotent simulated submission.

**What worked:** A pure policy function and strict request models made exact server-side assertions straightforward. SQLite enabled saved-case recovery and repeatable tests with temporary databases.

**What could improve:** Contributors need one documented canonical command for starting with an isolated database and a concise map from endpoint to state transition. The project documents both; browser-tool writes still need clear names so reviewers understand which ones are synthetic mutations.

**Onboarding:** Create the local virtual environment from `backend/requirements.lock`, start Uvicorn on loopback, and run the policy/API tests. No retailer data is involved.

**Build again?** Yes; the Python boundary makes the simulation's eligibility and consent checks testable without calling a merchant.

## React, TypeScript, Vite and Playwright

**Used for:** The shared return workflow, three visual versions, real MCP browser client, approval controls, responsive presentation and isolated browser tests.

**What worked:** One shared workflow made it possible to test the same policy/consent behavior in distinct layouts. Playwright exercised the browser's actual MCP request sequence, reload recovery and narrow layout.

**What could improve:** A first-run Playwright browser download is a separate setup step. Documenting how that runtime is stored locally and how E2E uses a temporary database helps reduce surprises; the README now includes both.

**Onboarding:** Run `npm ci`, install local Chromium once with Playwright, run Vite against the loopback API and launch `npm run test:e2e`.

**Build again?** Yes, for an interactive demo that reviewers can run locally with repeatable desktop and mobile coverage.

## Ollama local selector (optional)

**Used for:** A local-only tool-selection experiment with `qwen3:4b`; deterministic fake selection remains the default. A prior local check used the installed loopback service without downloading a model during that check, and tests cover failure/fallback.

**What worked:** Keeping the model to tool-name selection and rebuilding arguments in Python keeps it away from policy facts and approval state. Loopback validation and deterministic fallback make the project usable without Ollama.

**What could improve:** Initial model acquisition and local resource needs are separate from this repository's install flow. Clear provider status and a no-model default are important for reviewers who do not already run Ollama.

**Onboarding:** Install Ollama locally, select/download the chosen model through Ollama, set the documented loopback provider variables, then start the same API/UI. No remote model endpoint or credentials are supported.

**Build again?** Maybe, when users explicitly want local natural-language tool selection; the basic demo works without the model.

## Amazon Alexa+ SDK, APIs and partner tools

**First-hand product feedback:** None. This project did not use an Amazon API, Alexa+ SDK, Category SDK, MCP Toolkit, Alexa+ production account, hardware, or cloud service. Official current documentation describes some preview tooling as partner-restricted, so this feedback cannot honestly assess their installation or runtime behavior. The project is only a local web simulation.

**Build again?** The simulation path is useful for developing and evaluating an interaction boundary before an eligible developer has access to production Alexa+ tools. If access is granted later, a separate integration review would be required; none is implied here.