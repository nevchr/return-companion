# Alexa+ hackathon requirements and current route

**Checked October 6, 2026.** Recheck before submission; the event rules page records a September 16, 2026 update.

## Route selected

Return Companion uses the Alexa+ simulation route: a web application demonstrates one local assistant workflow over synthetic purchases and a self-hosted MCP Streamable HTTP endpoint. It is not an Alexa+ service integration, does not use an Amazon account or retailer APIs, and does not claim to be a production Alexa add-on. Amazon's current docs say its Category SDK and MCP Toolkit are available only to select partners; no participant should imply access if they do not have it.

The actual browser client negotiates MCP `2025-11-25`, discovers its small tool set and calls the local server. The interaction is functional: assistant intent may prepare a persisted proposal, Python controls eligibility and terms, the user approves an exact offer, then a separate UI confirmation calls an approval-gated simulated-submission tool. The same saved case survives reload.

## Project and submission requirements

The live rules allow a project using either a qualifying Agent Skill/self-hosted MCP server or a simulated Alexa+ web experience using the developer's preferred agentic tool. The project repository must include source, assets and clear setup instructions. For public source, include a detectable open-source license; a conventional OSI license is a project choice, not a mandated license. The alternative is a private repository shared with the required reviewers.

A final entry requires an English project description, repository URL, primary track, product feedback for the tools/APIs/SDKs actually used, and a publicly hosted demo video under three minutes (YouTube or Vimeo). The demo should show the app working on its intended platform. Do not submit a draft video or entry until reviewed by the project owner.

The separate Open Source mini-challenge calls for an additional open-source project or contribution; publishing the primary-track Return Companion repo alone may not satisfy that distinct requirement. No such contribution is claimed here.

## What remains before event submission

- Capture and review the under-three-minute local browser demo.
- Confirm the repository URL and license metadata after public repository creation.
- Review the English project description, track and product-feedback draft.
- Decide whether to make an additional, separate open-source contribution for the mini-challenge.
- Submit the project and video by the official deadline only after the owner reviews the final entry.

## Sources

- [Official event rules](https://amazonappdev2026.devpost.com/rules) (updated September 16, 2026)
- [Official hackathon overview](https://amazonappdev2026.devpost.com/)
- [Official resources](https://amazonappdev2026.devpost.com/resources)
- [Amazon Alexa+ developer documentation](https://developer.amazon.com/docs/alexaplus/add-ons/home.html)
- [MCP Streamable HTTP specification 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)

The current overview/rules show an October 23, 2026, 12:00 p.m. PDT deadline (3:00 p.m. EDT). Verify the Devpost page again on submission day.