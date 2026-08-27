import * as context from "@go-like/context"

const expectedExports = [
  "afterFunc",
  "background",
  "canceled",
  "cause",
  "deadlineExceeded",
  "todo",
  "withCancel",
  "withCancelCause",
  "withDeadline",
  "withDeadlineCause",
  "withoutCancel",
  "withTimeout",
  "withTimeoutCause",
  "withValue"
].sort()

const actualExports = Object.keys(context).sort()
if (JSON.stringify(actualExports) !== JSON.stringify(expectedExports)) {
  throw new Error(`unexpected @go-like/context exports: ${actualExports.join(",")}`)
}

const [ctx, cancel] = context.withCancel(context.background())
const signal = ctx.done()
cancel()
if (signal === null || !signal.aborted || ctx.err() !== context.canceled) {
  throw new Error("built @go-like/context cancellation runtime failed")
}
