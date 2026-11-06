**English** · [简体中文](../../zh-cn/compression/OVERVIEW.md)

# Compression Domain

## Scope

This domain covers the prompt and context compression pipeline that reduces request
size before cache lookup, token budgeting, and routing. It documents the
compression modes (lossless, standard, aggressive), the individual engines,
preservation guarantees and fidelity gates, per-request controls, custom
tool-output filters, and the statistics/preview APIs. It also covers the two
output savers (caveman and ponytail) that reduce the tokens coming back.

## File index

| File | Description |
| --- | --- |
| [01-compression-pipeline.md](01-compression-pipeline.md) | Complete reference for compression modes, engines, fidelity gates, adaptive triggering, tool-output filters, settings APIs, and MCP tool access. |
| [02-output-savers.md](02-output-savers.md) | Output-side terseness savers: caveman and ponytail levels, environment and API controls, the `X-FreeLLM-Saver` request header, injection order and cache effects. |

## Related

- [../api/](../api/) — API reference showing `X-FreeLLM-Compress` response header.
- [../clients/](../clients/) — Coding agents that benefit from automatic compression.
- [../../zh-cn/compression/](../../zh-cn/compression/) — Simplified Chinese mirror (when translated).