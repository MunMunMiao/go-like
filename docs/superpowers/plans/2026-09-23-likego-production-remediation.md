# LikeGo Production Evidence Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the evidence-backed gaps that prevent LikeGo from making an unconditional production-readiness claim.

**Architecture:** Keep the library behavior unchanged where evidence points to an upstream runtime or test harness. Add release-time package-contract checks, isolate orphan-process tests from automatic cleanup, expose the already-supported gRPC service options through generated glue, and make production-shaped acceptance boundaries executable and explicit.

**Tech Stack:** Bun, Node, TypeScript, Buf, npm/Bun package archives, Connect, native `node:http2`, existing E2E runner.

**Spec:** `/tmp/likego-production-20-20260923-2u0xco97/FINAL_REPORT.md` and `FINDINGS.md`.

## Global Constraints

- Main behavior changes must be minimal and only address confirmed findings.
- Deno 2.9.7 `node:http2` drain remains documentation-only; do not add a library workaround.
- The main checkout must pass existing gates; do not weaken assertions or hide failures.
- Physical tarball tests must resolve only package contents and installed dependencies, never workspace source paths.
- Every new check must preserve the initial failing log and record command, runtime, exit code, and timeout status.

## Review Focus

- A package archive whose `exports` target is absent must fail before publication; test archive extraction and Node/Bun import.
- The orphan-process fixture must observe descendants after the parent exits; test must not be auto-cleaned before the assertion.
- Generated gRPC registration must preserve public service options, including `readMaxBytes` and `writeMaxBytes`, and reject oversized messages before the handler.
- A known Deno runtime failure must remain version-scoped documentation, not be misclassified as a LikeGo failure.
- Production-shaped project results must distinguish same-process recreation from different-PID recovery and must not imply HA, backup, or capacity evidence.

---

### Task 1: Add a physical package contract gate

**Files:**
- Create: `scripts/verify-packed-exports.ts`
- Modify: `package.json` (add a script entry only if the repository convention requires it)
- Modify: `e2e/published.ts` (invoke the contract check before runtime suites)
- Test: `scripts/verify-packed-exports.test.ts`

**Interfaces:**
- Consumes: package tarballs produced by the repository's existing pack workflow.
- Produces: `package-contract-results.json` with package name, archive, every export target, resolved file, Node import exit, Bun import exit, and failure reason.

- [ ] **Step 1: Write the failing contract test**

Create a fixture archive with `package.json` containing `exports: {".":"./src/index.ts"}` and `files: ["dist"]`, but no `src/index.ts`. Assert the checker returns a failed record naming the missing target. Create a valid archive fixture and assert it returns a pass.

- [ ] **Step 2: Run the focused test**

Run: `bun test scripts/verify-packed-exports.test.ts`
Expected: the missing-target fixture fails before the checker exists.

- [ ] **Step 3: Implement the minimal checker**

Extract each archive into a unique temporary directory, parse only its package manifest, normalize `exports` conditions to import/default/types targets, assert each target exists under the extracted package, then run `node --input-type=module -e 'await import(process.argv[1])'` and the equivalent Bun command against the extracted package. Never resolve through the repository root.

- [ ] **Step 4: Run the focused test and current tarball matrix**

Run: `bun test scripts/verify-packed-exports.test.ts` and the checker against all 45 campaign tarballs.
Expected: valid campaign archives pass; a deliberately malformed archive fails with a nonzero exit and machine-readable reason.

- [ ] **Step 5: Integrate with published verification**

Run: `bun e2e/run.ts --suite published`.
Expected: the contract check runs before runtime assertions; Deno 2.9.7 drain remains a separately labeled external-runtime result.

### Task 2: Separate orphan-process tests from automatic orphan cleanup

**Files:**
- Modify: `e2e/definitions.ts:115-123`
- Create: `e2e/run-runner-process.ts`
- Modify: `e2e/runner-process.test.ts` only if the dedicated entry needs shared cleanup helpers
- Test: `e2e/runner-process.test.ts`

**Interfaces:**
- Consumes: the existing `runCommand`, `processIsRunning`, and explicit `finally` cleanup assertions.
- Produces: one registered suite that runs the runner-process tests without `--no-orphans`, while ordinary suites retain `--no-orphans`.

- [ ] **Step 1: Add a failing registration-level test**

Run the current registered command exactly as recorded in `evidence/e2e/runner-process.log` and assert all 8 runner-process tests are executed. Preserve the current 6-pass/2-fail output as the regression fixture.

- [ ] **Step 2: Implement the dedicated boundary**

Change only the `runner-process` suite command to invoke the dedicated file with `bun test --isolate e2e/runner-process.test.ts`; keep `--no-orphans` on all unrelated definitions. Keep the test file's explicit descendant cleanup in `finally` blocks.

- [ ] **Step 3: Verify the intended behavior**

Run: `bun e2e/run.ts --suite runner-process` and `bun test --isolate --no-orphans e2e/runner-process.test.ts`.
Expected: the dedicated suite passes all 8 scenarios; the ordinary command continues to demonstrate why it is unsuitable for this fixture.

### Task 3: Forward service-level gRPC options through generated glue

**Files:**
- Modify: `packages/protoc-gen-like/src/index.ts:45-52`
- Modify: `packages/protoc-gen-like/test/public-api.test.ts`
- Modify: `packages/protoc-gen-like/test/public-types.ts`
- Modify: `packages/transport/grpc-buf/test/options.test.ts`
- Modify: `doc/zh-Hans/guide/streaming.md` and the corresponding English reference

**Interfaces:**
- Consumes: `ServiceRegistrar.service(descriptor, implementation, serviceOptions)` and the existing generated handler registration.
- Produces: `registerXHandler(server, handler, serviceOptions?)` where the third argument is the public Connect service-options type and is passed unchanged to `.service`.

- [ ] **Step 1: Add the failing generated API test**

Generate a fixture service and compile a call to `registerOrderHandler(server, handler, { readMaxBytes: 65536, writeMaxBytes: 65536 })`. Add a runtime test that sends a 70 KiB request and asserts `ResourceExhausted` before the handler counter increments.

- [ ] **Step 2: Run the focused tests**

Run: `bun test packages/protoc-gen-like/test/public-api.test.ts packages/transport/grpc-buf/test/options.test.ts`.
Expected: the third argument is currently rejected or not forwarded.

- [ ] **Step 3: Implement the smallest generator change**

Import the existing service-options type, emit an optional third parameter, and pass it as the third argument to `server.service`. Do not duplicate native server limits or change defaults.

- [ ] **Step 4: Verify both runtimes and generated artifacts**

Run: `bun run test:protobuf`, `bun test packages/transport/grpc-buf/test/options.test.ts`, and the physical package contract gate. Expected: default behavior is unchanged; explicit limits reject before handler execution on Node and Bun.

### Task 4: Align health and metrics authentication with project contracts

**Files:**
- Modify: `/tmp/likego-production-20-20260923-2u0xco97/projects/_support.ts:124-136`
- Modify: each affected project `README.md` contract section
- Test: each affected project `smoke.ts` or shared HTTP boundary test

**Interfaces:**
- Consumes: the existing `actor()`/`credentials()` authentication path and deployment health probe requirements.
- Produces: an explicit policy: health is internal-network-only and anonymous, or health and metrics both require configured credentials; the same policy is tested and documented.

- [ ] **Step 1: Add the failing contract assertions**

For `/ready`, `/health/ready`, `/health/live`, and `/metrics`, issue anonymous, wrong-token, and correct-token requests. Assert the result matches the selected deployment policy; preserve the current result where it disagrees with the README.

- [ ] **Step 2: Choose the least-surprising boundary**

Keep liveness/readiness anonymous only when the deployment binds probes to an internal interface or ingress ACL. Require authentication for metrics, or bind metrics to a private listener. Do not put bearer credentials in public probe URLs.

- [ ] **Step 3: Implement the shared helper change**

Move metrics behind the chosen auth gate or add a private metrics listener; keep readiness usable by the orchestrator under the documented network boundary. Update every affected README with the exact curl policy.

- [ ] **Step 4: Verify all three auth states**

Run the shared smoke/reliability commands under Bun and Node. Expected: anonymous, wrong-token, and correct-token behavior is identical to the README and no metric body is exposed outside its intended boundary.

### Task 5: Make runtime limitations and production boundaries executable

**Files:**
- Modify: `e2e/published.ts` and its result schema
- Modify: `doc/zh-Hans/reference/verification.md`, `doc/guide/verification.md`, and the runtime compatibility section
- Modify: campaign project result schema or add `evidence/project-acceptance.schema.json`
- Test: `e2e/published.ts` and campaign acceptance scripts

**Interfaces:**
- Consumes: existing `ROOT-001`, `ROOT-002`, 20 project `RESULTS.md` files, physical results, and soak JSON.
- Produces: separate statuses for `library`, `application`, `test-harness`, and `external-runtime`; explicit fields for different-PID recovery, HA, failover, backup/restore, and capacity.

- [ ] **Step 1: Add failing schema fixtures**

Create one result with `sameProcessRestart: true` and `differentPidRecovery: false`; assert the aggregator does not label it durable recovery. Create one Deno drain result with `owner: external-runtime`; assert it cannot fail the library readiness score.

- [ ] **Step 2: Implement aggregation without changing test meaning**

Keep raw logs untouched. Add a bounded aggregation step that reports missing evidence as `unproven`, not `pass`, and copies runtime owner and reproduction links into the final report.

- [ ] **Step 3: Verify the complete matrix**

Run: the full gates, all registered E2E, both 3-minute soaks, all 20 source result readers, and all physical tarball checks. Expected: no claim of HA/capacity is emitted unless a corresponding evidence field exists.

### Task 6: Review and close the plan with release evidence

**Files:**
- Create: `docs/release/production-readiness-matrix.md`
- Modify: `README.md` only for links to the matrix and runtime limitation docs
- Test: CI or release job invoking Tasks 1–4

**Interfaces:**
- Consumes: Task 1–5 machine-readable results.
- Produces: a release matrix that can say `pilot-ready`, `production-ready-for-scope`, or `blocked`, with exact evidence links and explicit missing domains.

- [ ] **Step 1: Write the matrix from actual result fields**

List every package/runtime combination, the tested backend, source-vs-tarball mode, graceful stop, persistence mode, and known external limitation. Leave unsupported cells as `unproven`.

- [ ] **Step 2: Run the release command from a clean temporary consumer**

Run: `bun run verify:production-matrix` from a fresh directory with no workspace path aliases. Also execute each project's compiled JS or explicitly record that it is Bun-only; do not use `tsx` source loading as a production artifact check.
Expected: a clean report and nonzero exit for a deliberately malformed archive, missing compiled entry, or missing required evidence.

- [ ] **Step 3: Complete the review**

Run: `bun run fmt:check`, `bun run lint:check`, `bun run typecheck`, `bun run build`, `bun run test:unit:coverage`, `bun audit`, registered E2E, and the physical package matrix. Record all command lines and exits beside the matrix.

## Self-review

- Scope coverage: package publication, E2E harness, generated gRPC options, runtime classification, and release acceptance are each covered by a separate task.
- No runtime workaround is proposed for Deno 2.9.7, matching the confirmed ownership boundary.
- No task treats local soak throughput as capacity certification.
- Every task has a focused failing check, a minimal implementation, and a final command.
