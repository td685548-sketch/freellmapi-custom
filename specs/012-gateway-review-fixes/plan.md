# Implementation plan
Use one canonical ChatMessage representation through RTK, Headroom and PXPIPE. Apply model authorization before protocol conversion. Add isolated protocol SSE emitters. Recover and review the previously tested custom native executors; integrate their credential wrapper at account inference call sites. Keep existing DB encryption and storage with compare-and-swap refresh persistence. No schema/dependency changes.

Constitution check: encrypted credentials, no secret responses, modular new files and minimal entry points, no changes to upstream migrations.
