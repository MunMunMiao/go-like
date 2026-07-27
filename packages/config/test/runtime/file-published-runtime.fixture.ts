import { background, withCancelCause } from "@likego/context"
import * as ConfigFilePackage from "@likego/config/file"
import { fileSource, jsonFileDecoder } from "@likego/config/file"

function check(condition, message) {
  if (!condition) throw new Error(`config-file published assertion failed: ${message}`)
}

function deferred() {
  let resolveValue
  let rejectValue
  const promise = new Promise(function capture(resolve, reject) {
    resolveValue = resolve
    rejectValue = reject
  })
  return { promise, resolve: resolveValue, reject: rejectValue }
}

async function failure(action) {
  try {
    await action()
  } catch (error) {
    return error
  }
  throw new Error("config-file published failure scenario unexpectedly succeeded")
}

function nativeWatcher(terminal, onStop) {
  return {
    async stop(ctx) {
      if (onStop !== undefined) await onStop(ctx)
      terminal.resolve()
    },
    done() {
      return terminal.promise
    }
  }
}

async function constructionAndLoadScenarios() {
  check(
    Object.keys(ConfigFilePackage).sort().join(",") === "fileSource,jsonFileDecoder",
    "runtime surface drifted"
  )
  const decoded = jsonFileDecoder('{"values":[null,true,7,"text",{"nested":[]}]}', "config.json")
  check(
    decoded.values.length === 5 && decoded.values[4].nested.length === 0,
    "complete JSON value domain drifted"
  )
  for (const document of ["[]", "null", "7", '{"__proto__":"bad"}']) {
    check(
      (await failure(function decodeInvalid() {
        return Promise.resolve(jsonFileDecoder(document, "config.json"))
      })) instanceof Error,
      "invalid JSON document was admitted"
    )
  }

  const validCapability = {
    async read() {
      return { text: "{}", revision: null }
    }
  }
  for (const construct of [
    function nullCapability() {
      return fileSource(null, "config.json")
    },
    function absentRead() {
      return fileSource({}, "config.json")
    },
    function numericRead() {
      return fileSource({ read: 1 }, "config.json")
    },
    function numericWatch() {
      return fileSource({ read: validCapability.read, watch: 1 }, "config.json")
    },
    function emptyPath() {
      return fileSource(validCapability, "")
    },
    function emptyName() {
      return fileSource(validCapability, "config.json", { name: "" })
    },
    function invalidDecoder() {
      return fileSource(validCapability, "config.json", { decode: "invalid" })
    }
  ]) {
    check(
      (await failure(function rejectInvalidConstruction() {
        return Promise.resolve(construct())
      })) instanceof TypeError,
      "invalid file source construction was admitted"
    )
  }

  const capability = {
    root: "/srv/app",
    read(_ctx, path) {
      return Promise.resolve({
        text: `{"path":"${this.root}${path}","enabled":true}`,
        revision: "mtime:42"
      })
    }
  }
  const source = fileSource(capability, "/config.json", { name: "application-file" })
  capability.read = function replacedRead() {
    throw new Error("captured read was replaced")
  }
  const snapshot = await source.load(background())
  check(
    snapshot.value.path === "/srv/app/config.json" &&
      snapshot.value.enabled === true &&
      snapshot.revision === "mtime:42",
    "captured file load drifted"
  )

  const supplied = { database: { port: 5432 } }
  const custom = fileSource(
    {
      async read() {
        return { text: "port=5432", revision: null }
      }
    },
    "settings.toml",
    {
      decode(text, path) {
        check(text === "port=5432" && path === "settings.toml", "decoder arguments drifted")
        return supplied
      }
    }
  )
  const customSnapshot = await custom.load(background())
  supplied.database.port = 9000
  check(customSnapshot.value.database.port === 5432, "decoded value was not isolated")
}

async function watcherScenarios() {
  const terminal = deferred()
  const stops = []
  let notify = null
  const source = fileSource(
    {
      async read() {
        return { text: "{}", revision: "r1" }
      },
      async watch(_ctx, _path, changed) {
        notify = changed
        changed()
        changed()
        return nativeWatcher(terminal, async function stopNative() {
          stops.push("stopped")
        })
      }
    },
    "config.json"
  )
  const watcher = await source.watch(background(), "r1")
  await watcher.next(background())
  const pending = watcher.next(background())
  notify()
  notify()
  await pending
  await watcher.next(background())
  await watcher.stop(background())
  check(stops.join(",") === "stopped", "file watcher stop drifted")
  check(
    (await failure(function nextAfterStop() {
      return watcher.next(background())
    })) instanceof Error,
    "stopped watcher admitted next"
  )

  const retainedTerminal = deferred()
  const retainedSource = fileSource(
    {
      async read() {
        return { text: "{}", revision: null }
      },
      async watch(_ctx, _path, changed) {
        changed()
        return nativeWatcher(retainedTerminal)
      }
    },
    "config.json"
  )
  const retained = await retainedSource.watch(background(), null)
  const cancellation = new Error("pre-canceled next")
  const [ctx, cancel] = withCancelCause(background())
  cancel(cancellation)
  check(
    (await failure(function canceledNext() {
      return retained.next(ctx)
    })) === cancellation,
    "pre-canceled next lost its Context cause"
  )
  await retained.next(background())
  await retained.stop(background())
}

async function acceptanceAndTerminalScenarios() {
  const cancellation = new Error("watch acceptance canceled")
  const [ctx, cancel] = withCancelCause(background())
  const terminal = deferred()
  let stops = 0
  const source = fileSource(
    {
      async read() {
        return { text: "{}", revision: null }
      },
      async watch() {
        cancel(cancellation)
        return nativeWatcher(terminal, async function stopNative() {
          stops += 1
        })
      }
    },
    "config.json"
  )
  check(
    (await failure(function canceledWatch() {
      return source.watch(ctx, null)
    })) === cancellation && stops === 1,
    "watch acceptance rollback drifted"
  )

  const passive = deferred()
  const passiveSource = fileSource(
    {
      async read() {
        return { text: "{}", revision: null }
      },
      async watch() {
        return nativeWatcher(passive)
      }
    },
    "config.json"
  )
  const watcher = await passiveSource.watch(background(), null)
  const pending = watcher.next(background())
  const passiveFailure = new Error("native watcher failed")
  passive.reject(passiveFailure)
  check(
    (await failure(function waitForPassiveFailure() {
      return pending
    })) === passiveFailure,
    "native terminal failure drifted"
  )
  await failure(function stopFailedNativeWatcher() {
    return watcher.stop(background())
  })

  const malformed = fileSource(
    {
      async read() {
        return { text: "{}", revision: null }
      },
      async watch() {
        return {}
      }
    },
    "config.json"
  )
  check(
    (await failure(function rejectMalformedWatcher() {
      return malformed.watch(background(), null)
    })) instanceof TypeError,
    "malformed native watcher was admitted"
  )
}

export async function run() {
  await constructionAndLoadScenarios()
  await watcherScenarios()
  await acceptanceAndTerminalScenarios()
}
