# Data model

Existing `x_gateway_keys` encryption columns hold a version-1 OAuth JSON blob:
kind, accessToken, refreshToken, expiresAt, lastRefreshAt and optional identity,
account, plan, project and scope metadata. Kiro adds region, profileArn, authMethod,
clientId and clientSecret inside the same encrypted blob. No migration is needed.

New/imported grants have status unknown. A real inference probe can mark them
healthy. Saving a token does not create execution evidence. Failed permanent
refresh requires reconnecting; transient errors have a cooldown. Caches are
invalidated on database changes and ciphertext replacement.

Authorization attempts keep a random state, PKCE verifier/device grant, session
hash, owner, label, reconnect target, expiry and polling lock in server memory.
They expire after ten minutes and are discarded on restart. Refresh and device
registration secrets are never returned in start/poll responses.

ChatMessage has an optional is_error flag so failed tool results remain failures
after protocol translation. Parallel tool streams retain call IDs and stable
output item indices through terminal responses.
