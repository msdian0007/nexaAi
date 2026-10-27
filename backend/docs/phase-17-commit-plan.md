# Phase 17: step-sized commits

Phase 17 was implemented and validated as one phase, then split into these reviewable
local commits at the user's request:

| Step | Commit | Subject | Main changes |
| --- | --- | --- | --- |
| 17.1 | `7352d04` | `build(phase-17 step-17.1): package API worker and frontend images` | Backend/frontend Dockerfiles, migration runner, stable model cache, Nginx strategy and frontend build validation. |
| 17.2 | `d4fe09d` | `build(phase-17 step-17.2): compose the local NexaAI services` | Compose overlay, health checks, shared uploads/model volumes, root commands and smoke journey. |
| 17.3 | `5f81cb8` | `ci(phase-17 step-17.3): verify application and container builds` | GitHub Actions workflow with PostgreSQL, Redis, browser and image jobs. |
| 17.4 | `83053f6` | `feat(phase-17 step-17.4): validate runtime and build configuration` | Backend role validation, safe environment example and configuration tests. |
| 17.5 | this documentation commit | `docs(phase-17 step-17.5): document migration deployment and rollback` | Operating guide, validation evidence, commit record and roadmap completion. |

The commits remain local. No push, registry upload, hosted workflow setting or
deployment was performed.
