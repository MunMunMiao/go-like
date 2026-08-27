# Framework Evidence Remediation Implementation Plan

> Execute task-by-task with focused RED/GREEN checks. Do not commit, push, release, deploy, rewrite historical campaign artifacts, or edit either primary checkout.

Execution record: checked items below refer to the frozen go-like revision `5bf7faee` and the separate dogfood worktrees listed here; they are not current-main verification claims.

**Goal:** Resolve the confirmed consumer and evidence-harness defects revealed by the 40-project campaign without changing go-like product APIs unless a current passing control proves a library defect.

**Worktrees:**

- go-like: `/Users/munmunmiao/Documents/web/likego/.worktrees/framework-evidence-fixes`
- harness: `/Users/munmunmiao/Documents/web/go-like-dogfood-framework-fixes`

## Task 1: Prove the current Store File lifecycle contract

**Files:** none

- [x] Run a normal start/read-write/stop/join control on a real temporary directory.
- [x] Prove the resident `start()` promise remains pending before stop.
- [x] Inject an acquire sentinel failure and verify identity-preserving rejection plus `failed` state.
- [x] Hold acquire pending, verify an outer deadline does not fabricate native cancellation, then release and join.
- [x] Run a Node `fs/promises` environmental control.

**Result:** all controls passed. No `@go-like/store-file`, Core, Health, Server, or Resilience change is justified.

## Task 2: Recover the unresolved application lifecycle evidence

**Files:** historical bundles are read-only

- [x] Recover MS-011's exact `waitForStore` implementation.
- [x] Determine whether the consumer awaits the resident `start()` promise.
- [x] Determine whether startup failures are preserved or converted to a generic timeout.
- [x] Recover the MS-013/016/017/018 restart choreography and identify missing restart identity evidence.

**Result:** MS-011 does not await `start()`, but retries terminal `failed` state and loses the original startup failure. MS-016/017 share a harness oracle that checks HTTP without first proving container restart identity. Both are consumer/harness defects, not current go-like product defects.

## Task 3: Make zero-command UX evidence explicit

**Files:**

- Modify: `go-like-dogfood-framework-fixes/src/contracts.ts`
- Modify: `go-like-dogfood-framework-fixes/src/evidence.ts`
- Modify: `go-like-dogfood-framework-fixes/test/evidence.test.ts`

- [x] Add a focused test proving an implicit `commandCount: 0` record is rejected.
- [x] Add a focused test proving an explicitly unobserved zero-command record is accepted.
- [x] Add a focused test proving an unobserved record cannot claim a non-zero command count.
- [x] Run the tests before implementation and record the RED result.
- [x] Add the smallest backward-compatible optional observation marker and validation branch.
- [x] Run build and the focused evidence tests to GREEN.

## Task 4: Persist the final project gate for new finalizations

**Files:**

- Modify: `go-like-dogfood-framework-fixes/src/contracts.ts`
- Modify: `go-like-dogfood-framework-fixes/src/gates.ts`
- Modify: `go-like-dogfood-framework-fixes/src/cli.ts`
- Modify: `go-like-dogfood-framework-fixes/test/gates.test.ts`

- [x] Add a RED test proving successful `finalize-project` does not yet create `verify-<project>.json`.
- [x] Define a versioned deterministic final-gate record containing project ID, producer SHA, evaluator result, and hashes of the evidence actually consumed by the gate.
- [x] Publish the artifact atomically only after project cleanup and gate evaluation.
- [x] Refuse malformed, symlinked, or conflicting existing artifacts; keep retry behavior deterministic.
- [x] Do not backfill any historical campaign directory.
- [x] Run build and focused gate/CLI tests to GREEN, including fsync retry and child-open/swap-back races.

## Task 5: Track and clean only run-owned Docker images

**Files:**

- Modify: `go-like-dogfood-framework-fixes/src/contracts.ts`
- Modify: `go-like-dogfood-framework-fixes/src/validation.ts`
- Modify: `go-like-dogfood-framework-fixes/src/cleanup.ts`
- Modify: `go-like-dogfood-framework-fixes/test/contracts.test.ts`
- Modify: `go-like-dogfood-framework-fixes/test/cleanup.test.ts`

- [x] Add RED validation tests for an optional exact image ID/reference ownership record.
- [x] Add RED cleanup tests for exact remove/readback, daemon drift, identity mismatch, ancestor containers, and pulled images.
- [x] Extend `CleanupCheck.kind` with `image` and keep historical records without owned images valid.
- [x] Inspect the exact image ID on the frozen daemon, require the sole recorded local tag and run ownership, remove only that tag with `--no-prune`, and read back ID absence.
- [x] Never invoke `docker image prune`, `--force`, or delete digest-pinned shared base images.
- [x] Route MS-011/MS-016/MS-017 builds through labeled ownership publication and exact readback before container creation.
- [x] Run build and focused validation/cleanup/runner tests to GREEN.

## Task 6: Add a no-side-effect consumer preflight

**Files:**

- Add: `go-like-dogfood-framework-fixes/src/preflight.ts`
- Add: `go-like-dogfood-framework-fixes/test/preflight.test.ts`
- Modify: `go-like-dogfood-framework-fixes/src/cli.ts`

- [x] Add RED fixtures for a missing tarball, an external/workspace lockfile edge, vendor closure mismatch, and Compose image mismatch.
- [x] Reuse the frozen campaign/project manifest and existing path/hash validation; do not implement a package-manager resolver.
- [x] Add one read-only `preflight-project <campaign-root> <project-id> <consumer-repo>` command.
- [x] Prove every failed fixture exits before Docker/process/port creation and writes no run artifact.
- [x] Run build and focused preflight/CLI tests to GREEN.

## Task 7: Repair and rerun application controls

**Files:** fresh clones from immutable project bundles only

- [x] In a fresh MS-011 clone, change the waiter to retry only `starting` and preserve the terminal state cause chain for `failed`.
- [x] Run ready, terminal-failure, and context-cancellation controls for the MS-011 waiter.
- [x] For MS-016/017, capture `compose ps`, container inspect state/exit code/timestamps, and role logs before classifying HTTP recovery failure.
- [x] Prove `kill -> terminal -> exact marker removal -> start` on real Docker for MS-016 and MS-017; MS-016 also covers SIGKILL.
- [x] Do not alter original bundles or campaign evidence.

## Task 8: Verification and handoff

- [x] Run the affected focused test files.
- [x] Run the harness build and all self-contained tests.
- [x] Record the two full-suite staging failures separately: the isolated producer checkout HEAD differs from the frozen `cd15313...` fixture prerequisite; 273 other tests pass.
- [x] Retain the 205-test go-like product control because no product source changed.
- [x] Inspect all worktree/clone diffs and statuses.
- [x] For every Docker experiment, remove and read back only resources created by that experiment.
- [x] Report confirmed fixes, disproved product hypotheses, remaining evidence gaps, and exact verification coverage.
