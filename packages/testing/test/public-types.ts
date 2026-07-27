import { background } from "@likego/context"
import type { Context } from "@likego/context"
import type { Server } from "@likego/core"

import type { ConformanceCase, ConformanceHarness } from "../src/index"
import {
  listenerConformanceCases,
  type ListenerConformanceCase,
  type ListenerLifecycleConformanceHandle,
  type ListenerFactory
} from "../src/listener"
import { serverConformanceCases, type ServerFactory } from "../src/server"

declare const server: Server

const factory: ServerFactory = () => server
const cases: readonly ConformanceCase[] = serverConformanceCases(factory)

const harness: ConformanceHarness = {
  register(testCase): void {
    void testCase.run()
  }
}

for (const conformanceCase of cases) harness.register(conformanceCase)

const done = Promise.resolve()
const listener: ListenerLifecycleConformanceHandle = {
  address(): string {
    return "127.0.0.1:1"
  },
  done(): Promise<void> {
    return done
  },
  close(_ctx: Context): Promise<void> {
    return done
  },
  ready(): Promise<void> {
    return done
  },
  force(_reason: Error): Promise<void> {
    return done
  },
  fail(_error: Error): void {},
  rebind(): Promise<void> {
    return done
  }
}
const listenerFactory: ListenerFactory = () => listener
const listenerCases: readonly ListenerConformanceCase[] = listenerConformanceCases(listenerFactory)
for (const conformanceCase of listenerCases) harness.register(conformanceCase)
void background()
