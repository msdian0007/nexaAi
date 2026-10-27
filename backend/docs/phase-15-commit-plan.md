# Phase 15: step-sized commit record

The full phase was implemented together, then split into five local commits at the
user's explicit request. Commit subjects include `phase-15 step-15.1` through
`phase-15 step-15.5`. Shared files were staged by their relevant changes, preserving
the final working-tree content. No push or deployment was performed.

| Commit topic | Main files/hunks | Dependency/validation |
| --- | --- | --- |
| 15.1 Trace IDs and logging foundation | `observability/telemetry.ts`; authentication identification; API telemetry options/middleware; CORS exposure; queue request ID and worker trace; browser API request ID | Build backend/frontend; retain legacy job support. Include the new Prisma schema/migration as storage groundwork before committing code that references `auditEvent`. |
| 15.2 Useful timing spans | Search, RAG, agent routing, processing and organization transaction timing hunks | Backend build; timing/trace isolation checks. These wrappers do not change model output or permission rules. |
| 15.3 Health and Operations read model | `operations.routes.ts`, queue ping/worker inspection, API routes; Operations page and navigation/CSS | Requires generated audit model because the shared router/page also reads audit history. Build and authorized/degraded-view checks. |
| 15.4 Atomic audit writers | `observability/audit.ts`, organization services, document creation/deletion and agent retry claim | Schema/migration must already be present. Stage these independently from timing hunks in shared services; run rollback, role and tenant tests. Read-side audit UI/router can be grouped here with 15.3 if a single reviewable commit is clearer. |
| 15.5 Verification and operations guide | New backend/browser/unit tests, fixture support, retention CLI/package scripts, expanded security runner and phase/roadmap docs | Run complete regression; retention defaults to dry-run. Do not apply maintenance just to make a commit. |

The schema is additive; no existing history is backfilled. Generate Prisma after
checking out a commit that changes the schema. For an independently runnable
history, stage API imports/mounts only when their target module is included, and
keep each commit's tests consistent with the behavior it introduces. Audit schema
foundation can be the first small preparatory commit or grouped with 15.4 before
15.3. These are dependency-aware topic groups, not instructions to split imports
away from their implementation or deploy incomplete phases.

The completed split follows these dependency groups: audit schema groundwork is
in 15.1; isolated logging checks are in 15.1; isolated Operations browser checks
are in 15.3; cross-feature integration, retention and operating guides are in 15.5.
The user authorized these local commits explicitly. Future commits, pushes, global
cleanup and deployment require their own task authorization.
