# Contracts
GET /api/cache/preferences: authenticated, view_cache (or settings parent); safe enabled/persist/ttl/cap metadata. PUT: edit_cache, strict optional boolean enabled/persist (at least one), atomic update. Existing DELETE /api/cache: clear_cache.
Administrative routes resolve specific child by HTTP method/path. Unknown paths fall back to the old parent, never any-of-child authorization. Sensitive key reveal/export retain original password requirements. Leaf grants do not unlock unrelated reads or writes. Public inference/bootstrap/member key endpoints are unchanged.
