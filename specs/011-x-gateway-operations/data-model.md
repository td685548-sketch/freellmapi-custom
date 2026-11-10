# Data model
No migration. Bounded in-memory probe evidence is keyed by console session hash,
protocol and model, expires after five minutes and disappears on restart. It stores
no raw credentials or inference output. Existing client keys remain hash-only.
