# Data model
No persistent schema changes.
- Selection: nullable positive profile ID, search text (max 200), booleans for vision/tools, nonnegative context threshold, whitelisted sort column/direction.
- Snapshot: random opaque ID, DB identity, explicit profile ID, creation time, thin grouped index, routing settings and budget totals. Bounded cache and five-minute continuation lifetime.
- Page: at most 20 complete logical groups represented as flat member entries, group ranks, counts, next offset, snapshot ID, selected usage and routing settings.
- Edit batch: explicit profile ID and existing model IDs with positive priorities and boolean enabled flags. Omitted IDs are preserved.
