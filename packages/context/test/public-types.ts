import * as ContextPackage from "../src/index"
import {
  afterFunc,
  background,
  cause,
  withCancel,
  withCancelCause,
  withDeadline,
  withDeadlineCause,
  withoutCancel,
  withTimeout,
  withTimeoutCause,
  withValue,
  type CancelCauseFunc,
  type CancelFunc,
  type Context,
  type ContextError,
  type StopFunc,
  type TimeoutContextError
} from "../src/index"

const parent: Context = background()
const cancel: CancelFunc = withCancel(parent)[1]
const cancelCause: CancelCauseFunc = withCancelCause(parent)[1]
const deadlineCancel: CancelFunc = withDeadline(parent, new Date())[1]
const deadlineCauseCancel: CancelFunc = withDeadlineCause(parent, new Date(), null)[1]
const timeoutCancel: CancelFunc = withTimeout(parent, 1)[1]
const timeoutCauseCancel: CancelFunc = withTimeoutCause(parent, 1, null)[1]
const valued: Context = withValue(parent, "key", "value")
const detached: Context = withoutCancel(valued)
const observedCause: Error | null = cause(detached)
const stop: StopFunc = afterFunc(parent, () => {})
const contextError: ContextError | null = parent.err()
const timeoutError: TimeoutContextError | null = null

void [cancel, cancelCause, deadlineCancel, deadlineCauseCancel, timeoutCancel]
void [timeoutCauseCancel, observedCause, stop, contextError, timeoutError]

// @ts-expect-error Context is type-only and has no runtime constructor.
ContextPackage.Context
// @ts-expect-error ContextError is type-only and has no runtime constructor.
ContextPackage.ContextError
// @ts-expect-error TimeoutContextError is type-only and has no runtime constructor.
ContextPackage.TimeoutContextError
// @ts-expect-error CancelFunc is type-only.
ContextPackage.CancelFunc
// @ts-expect-error CancelCauseFunc is type-only.
ContextPackage.CancelCauseFunc
// @ts-expect-error StopFunc is type-only.
ContextPackage.StopFunc
