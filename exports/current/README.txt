Revenue Intelligence Inbox - export (derived from app state; regenerated on every export)

manifest.json / manifest.csv      one row per source record (identity = source_type + source_id)
records/<ref>__<id8>.json         full context per record: source payload, routes, override, outputs
routes/<route>/<ref>__<id8>__<kind>.md   one file per ACTIVE route; a record with 2 routes has 2 files that link to each other
routes/log/intake-log.csv         shared log for text-less records routed to "log"
daily/<date>/                     shared outputs that reference many records
Obsolete routes disappear on re-export; the manifest keeps suggested_routes next to active_routes.