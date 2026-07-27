import { background, canceled, withCancelCause } from "@likego/context"
import * as CronerPackage from "@likego/croner"
import { newCronerServer } from "@likego/croner"
import { Cron } from "croner"

function check(condition, message) {
  if (!condition) throw new Error(`cron-croner published assertion failed: ${message}`)
}

async function failure(action) {
  try {
    await action()
  } catch (error) {
    return error
  }
  throw new Error("cron-croner published failure scenario unexpectedly succeeded")
}

function delay(timeoutMs) {
  return new Promise(function schedule(resolve) {
    setTimeout(resolve, timeoutMs)
  })
}

function deferred() {
  let resolveValue
  const promise = new Promise(function capture(resolve) {
    resolveValue = resolve
  })
  return { promise, resolve: resolveValue }
}

function paused(callback = function noOp() {}, options = {}) {
  return new Cron(
    "0 0 0 1 1 * 2099",
    {
      ...options,
      paused: true,
      catch: true
    },
    callback
  )
}

async function expectStartupFailure(factory, message) {
  const observed = await failure(function startInvalid() {
    return newCronerServer(factory).start(background())
  })
  check(observed instanceof Error, `${message} did not reject with Error`)
  return observed
}

async function verifySuccessfulLifecycle() {
  let factoryCalls = 0
  let callbackCalls = 0
  let runtimeCtx = null
  let native = null
  const server = newCronerServer(function create(ctx) {
    factoryCalls += 1
    runtimeCtx = ctx
    native = paused(
      function callback(job, callbackCtx) {
        check(job === native, "native Cron identity drifted")
        check(callbackCtx === ctx, "native Cron context drifted")
        callbackCalls += 1
      },
      { context: ctx }
    )
    return native
  })
  check(factoryCalls === 0 && native === null, "factory ran before start")

  const running = server.start(background())
  await Promise.resolve()
  check(factoryCalls === 1 && native.isRunning(), "native Cron was not resumed")
  await native.trigger()
  check(callbackCalls === 1, "native trigger did not remain available")
  const pending = await Promise.race([
    running.then(function terminal() {
      return "terminal"
    }),
    delay(0).then(function stillPending() {
      return "pending"
    })
  ])
  check(pending === "pending", "start fabricated a passive terminal")

  await Promise.all([server.stop(background()), server.stop(background()), running])
  check(native.isStopped(), "native Cron was not permanently stopped")
  check(runtimeCtx.err() === canceled, "runtime Context was not canceled")
  const consumed = await failure(function restart() {
    return server.start(background())
  })
  check(
    consumed instanceof Error && consumed.name === "CronerAlreadyStartedError",
    "Server was not one-shot"
  )
}

async function verifyArrayAndCanceledStopWaiter() {
  const stopped = []
  const first = paused()
  const second = paused()
  const firstStop = first.stop.bind(first)
  const secondStop = second.stop.bind(second)
  first.stop = function stopFirst() {
    stopped.push("first")
    firstStop()
  }
  second.stop = function stopSecond() {
    stopped.push("second")
    secondStop()
  }
  const server = newCronerServer(function createMany() {
    return [first, second]
  })
  const running = server.start(background())
  await Promise.resolve()
  const caller = withCancelCause(background())
  const callerFailure = new Error("stop caller left")
  caller[1](callerFailure)
  const observed = await failure(function canceledStopWaiter() {
    return server.stop(caller[0])
  })
  check(observed === callerFailure, "stop caller cancellation identity drifted")
  await running
  check(stopped.join(",") === "second,first", "native jobs did not stop in reverse order")
}

async function verifyFactoryContracts() {
  const nonFactory = await failure(async function constructNonFactory() {
    newCronerServer(null)
  })
  check(nonFactory instanceof TypeError, "non-function factory was accepted")

  const empty = await expectStartupFailure(function emptyFactory() {
    return []
  }, "empty array")
  check(
    empty instanceof TypeError && empty.message.includes("at least one"),
    "empty array contract drifted"
  )
  const nonArray = await expectStartupFailure(function objectFactory() {
    return {}
  }, "non-native result")
  check(
    nonArray instanceof TypeError && nonArray.message.includes("native Cron"),
    "non-native contract drifted"
  )

  const duplicate = paused()
  const duplicateFailure = await expectStartupFailure(function duplicateFactory() {
    return [duplicate, duplicate]
  }, "duplicate result")
  check(
    duplicateFailure.message.includes("duplicate") && duplicate.isStopped(),
    "duplicate rollback drifted"
  )

  const stopped = paused()
  stopped.stop()
  const stoppedFailure = await expectStartupFailure(function stoppedFactory() {
    return stopped
  }, "stopped result")
  check(stoppedFailure.message.includes("already stopped"), "stopped result contract drifted")

  const releaseBusy = deferred()
  const busy = paused(async function held() {
    await releaseBusy.promise
  })
  const active = busy.trigger()
  await Promise.resolve()
  check(busy.isBusy(), "busy fixture did not enter callback")
  const busyFailure = await expectStartupFailure(function busyFactory() {
    return busy
  }, "busy result")
  check(busyFailure.message.includes("busy") && busy.isStopped(), "busy rollback drifted")
  releaseBusy.resolve()
  await active

  const running = paused()
  running.isRunning = function reportRunning() {
    return true
  }
  const runningFailure = await expectStartupFailure(function runningFactory() {
    return running
  }, "running result")
  check(runningFailure.message.includes("paused: true"), "running result contract drifted")

  const notPaused = new Cron("0 0 0 1 1 * 2099", function noOp() {})
  const notPausedFailure = await expectStartupFailure(function runningNativeFactory() {
    return notPaused
  }, "unpaused result")
  check(notPausedFailure.message.includes("paused: true"), "unpaused result contract drifted")

  const declined = paused()
  declined.resume = function declineResume() {
    return false
  }
  const declinedFailure = await expectStartupFailure(function declinedFactory() {
    return declined
  }, "declined resume")
  check(
    declinedFailure.message.includes("could not resume") && declined.isStopped(),
    "declined resume rollback drifted"
  )

  const notRunning = paused()
  let resumed = false
  const nativeResume = notRunning.resume.bind(notRunning)
  const nativeIsRunning = notRunning.isRunning.bind(notRunning)
  notRunning.resume = function resumeButHideState() {
    resumed = true
    return nativeResume()
  }
  notRunning.isRunning = function hideRunningState() {
    return resumed ? false : nativeIsRunning()
  }
  const notRunningFailure = await expectStartupFailure(function notRunningFactory() {
    return notRunning
  }, "missing running state")
  check(
    notRunningFailure.message.includes("running state") && notRunning.isStopped(),
    "running-state rollback drifted"
  )
}

async function verifyStartupFailuresAndRollback() {
  const factoryError = new Error("factory failed")
  const exactFailure = await expectStartupFailure(function failFactory() {
    throw factoryError
  }, "Error factory failure")
  check(exactFailure === factoryError, "factory Error identity drifted")

  const thrownValue = { reason: "non-Error factory failure" }
  const normalized = await expectStartupFailure(function throwValue() {
    throw thrownValue
  }, "non-Error factory failure")
  check(
    normalized.cause === thrownValue && normalized.message.includes("non-Error"),
    "factory non-Error normalization drifted"
  )

  const cleanupFailure = new Error("partial cleanup failed")
  const accepted = paused()
  const acceptedStop = accepted.stop.bind(accepted)
  accepted.stop = function failCleanup() {
    acceptedStop()
    throw cleanupFailure
  }
  const partial = await expectStartupFailure(function partialFactory() {
    return [accepted, {}]
  }, "partial factory failure")
  check(partial instanceof AggregateError, "partial rollback was not aggregated")
  check(
    partial.errors.length === 2 && partial.errors[1] === cleanupFailure,
    "partial rollback ordering drifted"
  )

  const nonErrorCleanup = paused()
  const nativeStop = nonErrorCleanup.stop.bind(nonErrorCleanup)
  const cleanupValue = { reason: "non-Error cleanup" }
  nonErrorCleanup.stop = function throwCleanupValue() {
    nativeStop()
    throw cleanupValue
  }
  const normalizedCleanup = await expectStartupFailure(function partialNonErrorFactory() {
    return [nonErrorCleanup, null]
  }, "non-Error rollback failure")
  check(normalizedCleanup instanceof AggregateError, "non-Error rollback was not aggregated")
  check(
    normalizedCleanup.errors[1].cause === cleanupValue,
    "rollback non-Error normalization drifted"
  )

  const canceledBefore = withCancelCause(background())
  const beforeFailure = new Error("startup canceled before factory")
  canceledBefore[1](beforeFailure)
  let factoryCalls = 0
  const canceledServer = newCronerServer(function shouldNotRun() {
    factoryCalls += 1
    return paused()
  })
  const observedBefore = await failure(function startCanceled() {
    return canceledServer.start(canceledBefore[0])
  })
  check(
    observedBefore === beforeFailure && factoryCalls === 0,
    "pre-canceled startup accepted work"
  )

  const canceledDuring = withCancelCause(background())
  const duringFailure = new Error("startup canceled during resume")
  const resumed = paused()
  const nativeResume = resumed.resume.bind(resumed)
  resumed.resume = function resumeAndCancel() {
    const result = nativeResume()
    canceledDuring[1](duringFailure)
    return result
  }
  const observedDuring = await failure(function startThenCancel() {
    return newCronerServer(function createResumed() {
      return resumed
    }).start(canceledDuring[0])
  })
  check(
    observedDuring === duringFailure && resumed.isStopped(),
    "mid-resume cancellation rollback drifted"
  )
}

async function verifyStopFailures() {
  const exactStopFailure = new Error("single stop failed")
  const single = paused()
  const singleStop = single.stop.bind(single)
  single.stop = function failSingleStop() {
    singleStop()
    throw exactStopFailure
  }
  const singleServer = newCronerServer(function singleFactory() {
    return single
  })
  const singleRunning = singleServer.start(background())
  await Promise.resolve()
  const observedSingle = await failure(function stopSingle() {
    return singleServer.stop(background())
  })
  check(observedSingle === exactStopFailure, "single stop Error identity drifted")
  check(
    (await failure(function doneSingle() {
      return singleRunning
    })) === exactStopFailure,
    "single done identity drifted"
  )
  check(
    (await failure(function stopSingleAgain() {
      return singleServer.stop(background())
    })) === exactStopFailure,
    "shared stop identity drifted"
  )

  const firstFailure = new Error("first stop failed")
  const secondFailure = new Error("second stop failed")
  const first = paused()
  const second = paused()
  const firstStop = first.stop.bind(first)
  const secondStop = second.stop.bind(second)
  first.stop = function failFirst() {
    firstStop()
    throw firstFailure
  }
  second.stop = function failSecond() {
    secondStop()
    throw secondFailure
  }
  const aggregateServer = newCronerServer(function aggregateFactory() {
    return [first, second]
  })
  const aggregateRunning = aggregateServer.start(background())
  await Promise.resolve()
  const aggregate = await failure(function stopAggregate() {
    return aggregateServer.stop(background())
  })
  check(aggregate instanceof AggregateError, "multiple stop failures were not aggregated")
  check(
    aggregate.errors[0] === secondFailure && aggregate.errors[1] === firstFailure,
    "stop aggregation order drifted"
  )
  check(
    (await failure(function doneAggregate() {
      return aggregateRunning
    })) === aggregate,
    "aggregate done identity drifted"
  )

  const stopValue = { reason: "native non-Error stop" }
  const nonError = paused()
  const nonErrorStop = nonError.stop.bind(nonError)
  nonError.stop = function failWithValue() {
    nonErrorStop()
    throw stopValue
  }
  const nonErrorServer = newCronerServer(function nonErrorFactory() {
    return nonError
  })
  const nonErrorRunning = nonErrorServer.start(background())
  await Promise.resolve()
  const normalized = await failure(function stopNonError() {
    return nonErrorServer.stop(background())
  })
  check(
    normalized instanceof Error && normalized.cause === stopValue,
    "stop non-Error normalization drifted"
  )
  check(
    (await failure(function doneNonError() {
      return nonErrorRunning
    })) === normalized,
    "normalized done identity drifted"
  )
}

export async function run() {
  check(Object.keys(CronerPackage).join(",") === "newCronerServer", "runtime surface drifted")
  await verifySuccessfulLifecycle()
  await verifyArrayAndCanceledStopWaiter()
  await verifyFactoryContracts()
  await verifyStartupFailuresAndRollback()
  await verifyStopFailures()
}
