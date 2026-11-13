# HTTP contract index

Canonical complete contract: [../contracts.md](../contracts.md). DTOs/export names/bounds: [../data-model.md](../data-model.md).

Console /api/thruline/support/tenants/:id/service-desk: widget-config GET/PUT, copilot POST, copilot/jobs/:jobId GET, sla-policy GET/PUT, queue GET, tickets/:ticketId/routing PATCH. All reads/writes require verified console editor; no role/history/budget overrides.

Public /thruline/v1/support: widget/config GET safe projection, widget/intake POST verified session and strict intake; existing chat accepts only receipt reference and enforces current required schema server-side. Existing human reply endpoint remains explicit UI action.

No additional endpoints, aliases, automatic sending or preview AI calls. Owner agents must implement full error/replay/lifecycle semantics in the canonical contract, not only the happy-path index here.
