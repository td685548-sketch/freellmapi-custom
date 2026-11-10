# Decisions
Loopback HTTP preserves real auth/rate-limit/protocol paths without forwarding
secrets to an untrusted URL. Recent successful probes verify only their protocol
and selected model; static configuration never proves a remote provider works.
Local setup must never modify the hosted server's home directory.
