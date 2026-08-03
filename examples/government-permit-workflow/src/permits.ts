import type { Context } from "@likego/context"

/** Enumerates the permit policies supported by this example. */
export type PermitType = "renovation" | "restaurant"
export type PermitStatus = "pending" | "approved" | "needs_information"

export interface SubmitPermitCommand {
  readonly applicationId: string
  readonly applicantId: string
  readonly permitType: PermitType
  readonly documents: readonly string[]
}

export interface PermitRecord {
  readonly applicationId: string
  readonly applicantId: string
  readonly permitType: PermitType
  readonly documents: readonly string[]
  readonly status: PermitStatus
  readonly missingDocuments: readonly string[]
}

export interface PermitDecision {
  readonly status: "approved" | "needs_information"
  readonly missingDocuments: readonly string[]
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
const documentPattern = /^[a-z][a-z0-9-]{0,63}$/

/** Validates one permit submission at the application trust boundary. */
export function validatePermit(command: SubmitPermitCommand): void {
  if (!identifierPattern.test(command.applicationId)) {
    throw new TypeError("invalid applicationId")
  }
  if (!identifierPattern.test(command.applicantId)) throw new TypeError("invalid applicantId")
  if (command.permitType !== "renovation" && command.permitType !== "restaurant") {
    throw new TypeError("invalid permitType")
  }
  const observed = new Set<string>()
  for (const document of command.documents) {
    if (!documentPattern.test(document)) throw new TypeError("invalid document")
    if (observed.has(document)) throw new Error("duplicate document")
    observed.add(document)
  }
}

/** Produces the stable submission fingerprint for application-ID conflict detection. */
export function permitFingerprint(command: SubmitPermitCommand): string {
  const documents: string[] = []
  for (const document of command.documents) documents.push(document)
  documents.sort()
  return `${command.applicantId}\u0000${command.permitType}\u0000${documents.join("\u0000")}`
}

/** Reviews one permit against the document policy for its exact permit type. */
export function reviewPermit(record: PermitRecord): PermitDecision {
  const required = ["identity", "site-plan"]
  if (record.permitType === "restaurant") required.push("fire-safety")
  const missingDocuments: string[] = []
  for (const document of required) {
    if (!record.documents.includes(document)) missingDocuments.push(document)
  }
  return Object.freeze({
    status: missingDocuments.length === 0 ? "approved" : "needs_information",
    missingDocuments: Object.freeze(missingDocuments)
  })
}

export interface PermitRepository {
  submit(ctx: Context, command: SubmitPermitCommand): PermitRecord
  nextPending(ctx: Context): PermitRecord | null
  complete(ctx: Context, applicationId: string, decision: PermitDecision): PermitRecord
  find(ctx: Context, applicationId: string): PermitRecord | null
}

interface SavedPermit {
  readonly fingerprint: string
  readonly record: PermitRecord
}

/** Rejects work admitted from an already terminal Context. */
function checkContext(ctx: Context): void {
  const failure = ctx.err()
  if (failure !== null) throw failure
}

/** Copies one submitted permit into its immutable initial record. */
function pendingRecord(command: SubmitPermitCommand): PermitRecord {
  const documents: string[] = []
  for (const document of command.documents) documents.push(document)
  return Object.freeze({
    applicationId: command.applicationId,
    applicantId: command.applicantId,
    permitType: command.permitType,
    documents: Object.freeze(documents),
    status: "pending",
    missingDocuments: Object.freeze([])
  })
}

/** Creates a process-local permit repository preserving submission order. */
export function newMemoryPermitRepository(): PermitRepository {
  const permits = new Map<string, SavedPermit>()
  return Object.freeze({
    submit(ctx: Context, command: SubmitPermitCommand): PermitRecord {
      checkContext(ctx)
      const fingerprint = permitFingerprint(command)
      const saved = permits.get(command.applicationId)
      if (saved !== undefined) {
        if (saved.fingerprint !== fingerprint) throw new Error("application id conflict")
        return saved.record
      }
      const record = pendingRecord(command)
      permits.set(command.applicationId, Object.freeze({ fingerprint, record }))
      return record
    },
    nextPending(ctx: Context): PermitRecord | null {
      checkContext(ctx)
      for (const saved of permits.values()) {
        if (saved.record.status === "pending") return saved.record
      }
      return null
    },
    complete(ctx: Context, applicationId: string, decision: PermitDecision): PermitRecord {
      checkContext(ctx)
      const saved = permits.get(applicationId)
      if (saved === undefined) throw new Error("permit application not found")
      if (saved.record.status !== "pending") return saved.record
      const record = Object.freeze({
        applicationId: saved.record.applicationId,
        applicantId: saved.record.applicantId,
        permitType: saved.record.permitType,
        documents: saved.record.documents,
        status: decision.status,
        missingDocuments: decision.missingDocuments
      })
      permits.set(applicationId, Object.freeze({ fingerprint: saved.fingerprint, record }))
      return record
    },
    find(ctx: Context, applicationId: string): PermitRecord | null {
      checkContext(ctx)
      return permits.get(applicationId)?.record ?? null
    }
  })
}

export type SubmitPermit = (ctx: Context, command: SubmitPermitCommand) => PermitRecord

export type GetPermit = (ctx: Context, applicationId: string) => PermitRecord

/** Creates the permit-submission operation. */
export function newSubmitPermit(repository: PermitRepository): SubmitPermit {
  return function submitPermit(ctx: Context, command: SubmitPermitCommand): PermitRecord {
    validatePermit(command)
    return repository.submit(ctx, command)
  }
}

/** Creates the permit-query operation. */
export function newGetPermit(repository: PermitRepository): GetPermit {
  return function getPermit(ctx: Context, applicationId: string): PermitRecord {
    const permit = repository.find(ctx, applicationId)
    if (permit === null) throw new Error("permit application not found")
    return permit
  }
}
