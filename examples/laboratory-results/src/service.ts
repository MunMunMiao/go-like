import type { Context } from "@go-like/context"
import { newProbeRegistry, type ProbeRegistry } from "@go-like/health"
import {
  newMetadata,
  newServerContext,
  propagateToClientContext,
  type MetadataInput
} from "@go-like/metadata"

export interface Encounter {
  readonly encounterId: string
  readonly patientId: string
  readonly orderingClinicianId: string
}

export interface RecordLaboratoryResultCommand {
  readonly resultId: string
  readonly encounterId: string
  readonly patientId: string
  readonly orderingClinicianId: string
  readonly testCode: string
  readonly value: string
}

export interface LaboratoryResult {
  readonly resultId: string
  readonly encounterId: string
  readonly patientId: string
  readonly orderingClinicianId: string
  readonly testCode: string
  readonly value: string
}

export interface ResultReceipt {
  readonly resultId: string
  readonly encounterId: string
  readonly status: "accepted"
}

export interface ResultAuditEvent {
  readonly action: "laboratory_result_accepted"
  readonly resultId: string
  readonly encounterId: string
  readonly testCode: string
}

export interface LaboratoryResultRepository {
  encounter(ctx: Context, encounterId: string): Encounter | undefined
  save(ctx: Context, command: RecordLaboratoryResultCommand): ResultReceipt
  get(ctx: Context, resultId: string): LaboratoryResult | undefined
}

export interface ResultAuditSink {
  write(ctx: Context, event: ResultAuditEvent): void
}

export interface MemoryLaboratoryResultRepositoryOptions {
  readonly encounters: readonly Encounter[]
}

export interface MemoryResultAuditSink extends ResultAuditSink {
  events(ctx: Context): readonly ResultAuditEvent[]
}

export type RecordLaboratoryResult = (
  ctx: Context,
  command: RecordLaboratoryResultCommand
) => ResultReceipt

interface SavedResult {
  readonly fingerprint: string
  readonly result: LaboratoryResult
}

const forwardedMetadataKeys = Object.freeze(["x-encounter-id", "x-request-id"])

function validId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value)
}

/** Validates result shape without copying the sensitive value into an error. */
export function validateLaboratoryResult(command: RecordLaboratoryResultCommand): void {
  if (!validId(command.resultId)) throw new TypeError("invalid resultId")
  if (!validId(command.encounterId)) throw new TypeError("invalid encounterId")
  if (!validId(command.patientId)) throw new TypeError("invalid patientId")
  if (!validId(command.orderingClinicianId)) {
    throw new TypeError("invalid orderingClinicianId")
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(command.testCode)) {
    throw new TypeError("invalid testCode")
  }
  if (command.value.length === 0 || command.value.length > 4_096) {
    throw new RangeError("invalid result value length")
  }
}

function laboratoryResultFingerprint(command: RecordLaboratoryResultCommand): string {
  return [
    command.encounterId,
    command.patientId,
    command.orderingClinicianId,
    command.testCode,
    command.value
  ].join("\u0000")
}

/** Creates an in-memory clinical result repository. */
export function newMemoryLaboratoryResultRepository(
  options: MemoryLaboratoryResultRepositoryOptions
): LaboratoryResultRepository {
  const encounters = new Map<string, Encounter>()
  const results = new Map<string, SavedResult>()
  for (const encounter of options.encounters) {
    encounters.set(
      encounter.encounterId,
      Object.freeze({
        encounterId: encounter.encounterId,
        patientId: encounter.patientId,
        orderingClinicianId: encounter.orderingClinicianId
      })
    )
  }

  return Object.freeze({
    encounter(ctx: Context, encounterId: string): Encounter | undefined {
      const failure = ctx.err()
      if (failure !== null) throw failure
      return encounters.get(encounterId)
    },
    save(ctx: Context, command: RecordLaboratoryResultCommand): ResultReceipt {
      const failure = ctx.err()
      if (failure !== null) throw failure
      const fingerprint = laboratoryResultFingerprint(command)
      const saved = results.get(command.resultId)
      if (saved !== undefined) {
        if (saved.fingerprint !== fingerprint) throw new Error("idempotency conflict")
        return Object.freeze({
          resultId: saved.result.resultId,
          encounterId: saved.result.encounterId,
          status: "accepted"
        })
      }
      const result = Object.freeze({
        resultId: command.resultId,
        encounterId: command.encounterId,
        patientId: command.patientId,
        orderingClinicianId: command.orderingClinicianId,
        testCode: command.testCode,
        value: command.value
      })
      results.set(command.resultId, Object.freeze({ fingerprint, result }))
      return Object.freeze({
        resultId: result.resultId,
        encounterId: result.encounterId,
        status: "accepted"
      })
    },
    get(ctx: Context, resultId: string): LaboratoryResult | undefined {
      const failure = ctx.err()
      if (failure !== null) throw failure
      return results.get(resultId)?.result
    }
  })
}

/** Creates an audit sink whose event contract intentionally excludes clinical values. */
export function newMemoryResultAuditSink(): MemoryResultAuditSink {
  const saved: ResultAuditEvent[] = []
  return Object.freeze({
    write(ctx: Context, event: ResultAuditEvent): void {
      const failure = ctx.err()
      if (failure !== null) throw failure
      saved.push(
        Object.freeze({
          action: event.action,
          resultId: event.resultId,
          encounterId: event.encounterId,
          testCode: event.testCode
        })
      )
    },
    events(ctx: Context): readonly ResultAuditEvent[] {
      const failure = ctx.err()
      if (failure !== null) throw failure
      return saved.slice()
    }
  })
}

/** Creates a result receiver that proves the encounter relationship before persistence. */
export function newRecordLaboratoryResult(
  repository: LaboratoryResultRepository,
  audit: ResultAuditSink
): RecordLaboratoryResult {
  return function recordLaboratoryResult(
    ctx: Context,
    command: RecordLaboratoryResultCommand
  ): ResultReceipt {
    validateLaboratoryResult(command)
    const encounter = repository.encounter(ctx, command.encounterId)
    if (encounter === undefined) throw new Error("encounter not found")
    if (
      encounter.patientId !== command.patientId ||
      encounter.orderingClinicianId !== command.orderingClinicianId
    ) {
      throw new Error("result does not match encounter")
    }
    const receipt = repository.save(ctx, command)
    const event: ResultAuditEvent = Object.freeze({
      action: "laboratory_result_accepted",
      resultId: receipt.resultId,
      encounterId: receipt.encounterId,
      testCode: command.testCode
    })
    audit.write(ctx, event)
    return receipt
  }
}

/** Attaches one immutable inbound metadata snapshot to the server Context. */
export function withLaboratoryServerMetadata(ctx: Context, input: MetadataInput): Context {
  return newServerContext(ctx, newMetadata(input))
}

/** Projects only explicitly safe correlation fields into a downstream client Context. */
export function laboratoryDownstreamContext(ctx: Context): Context {
  return propagateToClientContext(ctx, { exact: forwardedMetadataKeys })
}

/** Wraps an audit sink so sensitive inbound metadata never crosses the downstream boundary. */
export function newSafeResultAuditSink(delegate: ResultAuditSink): ResultAuditSink {
  return Object.freeze({
    write(ctx: Context, event: ResultAuditEvent): void {
      delegate.write(laboratoryDownstreamContext(ctx), event)
    }
  })
}

/** Creates liveness and encounter-index readiness probes for the result service. */
export function newLaboratoryProbeRegistry(
  repository: LaboratoryResultRepository,
  readinessEncounterId: string
): ProbeRegistry {
  const probes = newProbeRegistry()
  probes.register("live", "laboratory.receiver", (ctx) => {
    const failure = ctx.err()
    if (failure !== null) throw failure
  })
  probes.register("ready", "laboratory.encounter-index", (ctx) => {
    if (repository.encounter(ctx, readinessEncounterId) === undefined) {
      throw new Error("encounter index is unavailable")
    }
  })
  return probes
}
