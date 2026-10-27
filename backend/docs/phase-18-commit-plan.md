# Phase 18 step-sized commit plan

After the whole phase is reviewed, commit it in these slices:

1. `feat(phase-18 step-18.1): define the pilot hosting and budget boundary`
   - hosting/capacity/cost decision and current source links
2. `feat(phase-18 step-18.2): add production database backups and restore drills`
   - PostgreSQL isolation, Restic export/backup/restore operations
3. `feat(phase-18 step-18.3): secure the production Redis queue`
   - authenticated persistent no-eviction Redis on a private network
4. `feat(phase-18 step-18.4): store documents in S3-compatible object storage`
   - storage adapter, upload/processing/deletion integration and tests
5. `build(phase-18 step-18.5): publish and run immutable production services`
   - registry workflow, migration-first API/worker composition and settings
6. `build(phase-18 step-18.6): terminate HTTPS and route the production frontend`
   - Caddy, same-origin API routing and SPA fallback configuration
7. `test(phase-18 step-18.7): verify the complete hosted tenant journey`
   - HTTPS signup/upload/worker/question/history/isolation verifier
8. `docs(phase-18 step-18.8): document monitoring recovery and operations`
   - monitoring thresholds, backup/restore, rollback and evidence checklist

Some files span multiple conceptual steps. Stage exact hunks during the later
commit operation so every commit builds and its message describes the included
behavior. Do not publish the commits until the user requests it.
