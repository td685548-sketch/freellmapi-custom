# Addendum: integration baseline after Thruline rename

Review round3 fetched origin/main at769e41454ec16ed347fa883b14a458143e5c81f9. Main renamed the console/public route mounts after the original018 specification was drafted. Apply this URL mapping when integrating018; preserve all018 behavior/security requirements and all main permission fixes.

| Original018 URL | Current canonical URL |
| --- | --- |
| /x/support-knowledge | /thruline/support-knowledge |
| /api/x-gateway/support/tenants | /api/thruline/support/tenants |
| /api/x-gateway/support/tenants/:id/knowledge-library | /api/thruline/support/tenants/:id/knowledge-library |
| /x/v1/support/* | /thruline/v1/support/* |

This changes externally mounted URL prefixes, not on-disk module paths, DB keys, role semantics or existing permission identifiers. Do not mass-rename `x-gateway` files or `use_x_gateway`/`edit_x_settings`. Preserve main's legacy console redirect and canonical widget base-path parser; do not add broad legacy server mounts/aliases or restore obsolete permission routes to satisfy old fixtures.

Safe main sync and conflict composition belong to the integration coordinator, before the owners' final verification. Keep pending018/016/Kiro work intact; no destructive reset, stash of others' work or direct commits to main. Agent3 owns new018 actual HTTP test URLs and module mounts; Agent4 owns Studio/nav/native test/served widget/widget tests. Do not change peer files without reporting the exact missing ownership.

Current tests on the pre-rename branch are useful regression evidence but cannot certify the final PR tree. Rerun on the composed current-main tree, including actual canonical HTTP routes, widget loaded at a deployment-prefixed canonical URL, client navigation/queries, and full required workspace checks.
