# Framework Evidence Remediation Design

**Date:** 2026-08-26

**Status:** Approved in conversation; implementation is evidence-gated.

## Goal

Reproduce the unresolved findings from the 40-project dogfood campaign against a frozen producer revision, distinguish library defects from consumer and harness defects, and apply only the smallest verified fix.

## Constraints

- Historical campaign evidence is immutable.
- A finding becomes library work only when go-like fails and a credible control passes.
- Dual-fail destinations do not justify a go-like API change.
- Existing one-shot `App` and `Server` lifecycle semantics remain unchanged unless a current failing control proves them insufficient.
- No new dependency, generic supervisor, automatic stale-lock takeover, or global recovery-budget abstraction is introduced without independent evidence from at least two consumers.
- The existing dirty `go-like-dogfood` checkout remains read-only. Harness work occurs in `/Users/munmunmiao/Documents/web/go-like-dogfood-framework-fixes`, based on the dogfood repository commit `57f2aa6b78218b21eae3e3f72b876daf8afa394b`.
- No commit, push, release, deployment, broad Docker prune, or modification of historical evidence is authorized.

## Confirmed Baseline

- The frozen go-like validation revision is `5bf7faee8926bd9664fcb8d9f41a2b61e6937dae`.
- Targeted tests for Core, Health, Server, Store File, and Resilience pass: 205 passed, 0 failed.
- `FileStore.start()` is a resident lifecycle promise. It reaches the running state after acquiring the directory and loading the snapshot, then settles only when the lifecycle terminates.
- Repository consumers already demonstrate the intended readiness pattern: retain and observe the resident promise, probe a harmless store operation, then stop and join.
- MS-011, MS-013, MS-016, MS-017, and MS-018 are historical dual-fail destinations and require fresh passing controls before product changes.

## Mature Framework Lessons

- Fastify separates readiness, listener admission, draining, and close hooks; a closed server is not a reusable restart primitive.
- NestJS separates lifecycle hooks from application-defined health indicators; shutdown hooks are explicit.
- Moleculer publishes service availability only after successful service start and withdraws availability before shutdown.
- Level-style stores expose opening/open/closing/closed states. `proper-lockfile` exposes an explicit release capability, but its stale-lock reclamation is incompatible with go-like's fail-closed single-owner contract.
- KafkaJS separates retry parameters from restart policy, so protocol-specific recovery budgets belong to the consumer contract rather than Core.
- npm and Docker already provide structured pack inspection and exact image identity/readback; the harness should reuse them rather than implement package or container resolvers.

## Design

### 1. Product contract experiments

Run four bounded controls against the frozen validation revision's `@go-like/store-file`:

1. Normal lifecycle: start without awaiting the resident promise, attach a rejection observer, wait for a harmless read to be admitted, write/read, stop, and join.
2. Startup failure: inject an acquire failure and prove the original error reaches the observer before the readiness deadline.
3. Pending native operation: hold acquire pending, prove the outer readiness deadline expires without claiming native cancellation, release the operation, then stop and join.
4. Node filesystem control: perform the corresponding directory/write/read/remove flow within the same environmental deadline.

Decision rule:

- If the library violates its documented lifecycle or loses the original error, add one failing regression and fix the shared implementation path.
- If the library behaves correctly, do not add `ready(ctx)` or change `start()`. Fix only the consumer waiter or harness oracle that misuses the resident promise.

### 2. Lifecycle and recovery experiments

For each unresolved lifecycle destination, recover the exact application choreography before running Docker:

- identify whether restart means a new process/new `App` or a second `run()` on a stopped instance;
- identify when `/livez` and `/readyz` begin listening;
- identify whether readiness depends on external recovery, registration, subscription, or lease state;
- ensure startup and terminal failures remain observable rather than becoming a generic timeout.

Fresh destination success requires a new process identity, bounded HTTP recovery, correct readiness admission, no stale registration, and exact resource cleanup. A shared library change is allowed only after a current go-like failure with a passing competitor or standard-library control.

### 3. Harness hardening

Implement only gaps not already present in the user's uncommitted harness work:

- fail-fast package/vendor/lockfile/Compose/image preflight before creating runtime resources;
- record only run-owned image references and IDs, clean them exactly, and read back absence on the same Docker daemon;
- reject an observed UX checkpoint with `commandCount = 0`, while allowing an explicit `unobserved` state;
- atomically persist a final-gate JSON artifact for new finalizations, including producer revision and input hashes;
- leave all historical campaign artifacts untouched.

## Verification

- Each changed behavior must first have a focused failing test against the real component or boundary.
- Run the focused test, affected package coverage gate, repository verification, and worktree status/diff review.
- Run fresh dogfood destinations only after static preflight passes.
- Applicable campaign evidence uses four lanes and three admitted repetitions per lane, followed by exact shutdown and cleanup readback.
- Evidence completeness and conformance remain separate outcomes.

## Non-goals

- In-process application supervisor or reusable stopped `App` instances.
- Automatic lifecycle-to-business-readiness mapping.
- Automatic stale file-lock reclamation.
- Generic cross-protocol recovery-budget configuration.
- Rewriting or backfilling immutable historical campaign evidence.
