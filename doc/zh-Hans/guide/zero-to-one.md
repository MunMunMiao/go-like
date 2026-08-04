# 诊所预约：从 0 到 1

这是一条从 0 到 1 的引导项目路径，通过真实业务不变量（无论请求从哪里来都必须保持的规则）学习 go-like，而不是再做一个泛化 Todo list。页面描述目标结构和可执行 checkpoint，不声称目标目录已经作为可复制运行的完整应用提交。项目是一个诊所预约服务，包含进程内 policy service（负责校验预约规则的内部服务）、作为权威来源的预约 repository、可丢弃的 availability cache、health endpoints，以及一个明确的 application lifecycle。

仓库里已经有 `examples/healthcare-appointments`，本指南以它为起点。它当前使用 raw JSON `Message` 处理 policy service。下面的 typed `Endpoint` 和 `Struct` 版本，是基于当前 public exports 写出的升级路径；本次文档阶段没有把它加入示例。描述验证结果时要把这两件事分开。

## 业务不变量

服务必须保持五条规则：

1. 同一位医生不能有时间重叠的 active appointments。
2. 取消预约后，时间段重新可用。
3. 使用同一个 appointment ID 重复提交同一预约请求时，操作必须幂等。
4. 复用 appointment ID 但提交不同预约内容时，必须拒绝。
5. Availability 只作为加速手段缓存；repository 仍然是权威来源。

当前仓库示例用内存 repository 实现了前四条规则，并通过内部 policy service 校验预约最大时长。它没有声称提供数据库、分布式锁、持久化 cache、authentication 或生产级预约流程。

## 你会构建什么

```text
clinic-appointments/
|-- package.json
|-- tsconfig.json
|-- README.md
|-- src/
|   |-- contract.ts       # typed policy Endpoint and Structs
|   |-- service.ts        # domain invariant and canonical repository
|   |-- transport.ts      # policy Server and Client over Memory Transport
|   |-- cache.ts          # availability cache and invalidation policy
|   |-- http.ts           # Fetch routes and health delegation
|   `-- main.ts           # one composition root and one Core App
`-- test/
    |-- main.test.ts      # domain, typed call, HTTP, cache, health, cancellation
    `-- node-e2e.ts       # real bind, request, stop, and port release
```

现有 workspace example 当前的目录树更小：

```text
examples/healthcare-appointments/
|-- package.json
|-- tsconfig.json
|-- README.md
|-- src/
|   |-- service.ts
|   |-- transport.ts      # current raw JSON policy boundary
|   |-- http.ts
|   `-- main.ts
`-- test/main.test.ts
```

第二棵树才是当前 checkout 里已经存在的真实结构。第一棵树是本教程各个里程碑的目标形态。

## 前置条件与命令

在 repository 根目录执行：

```sh
bun install --frozen-lockfile
```

当前 checkout 中，packages 通过 workspace dependencies 关联。根 repository 记录的验证矩阵是 Bun `1.3.14`、Node.js `26.x`、Deno `2.9.4`、TypeScript `7.0.2` 和 k6 `2.1.0`；Node.js 使用 26.x 的任意 patch 都可以。当前 package 文档说明这些 packages 尚未发布到 npm。

运行已有的 baseline example：

```sh
HOST=127.0.0.1 PORT=3000 bun run --cwd examples/healthcare-appointments start
```

`start` script 会构建 root packages、创建 prepared Node bundle，再运行它。发送请求前，先等到出现 `GO_LIKE_EXAMPLE_READY` 行。在另一个终端执行：

```sh
NOW=$(($(date +%s) * 1000))
curl -i -sS http://127.0.0.1:3000/v1/appointments \
  -H 'content-type: application/json' \
  -d "{\"appointmentId\":\"appointment-1\",\"doctorId\":\"doctor-1\",\"patientId\":\"patient-1\",\"startsAt\":$((NOW + 3600000)),\"endsAt\":$((NOW + 5400000))}"

curl -i -sS -X DELETE \
  http://127.0.0.1:3000/v1/appointments/appointment-1
```

用 `Ctrl-C` 停掉前台进程。不要为 policy service 再启动一个隐藏的 App；当前示例把 policy Server 和 Web Server 放进同一个 Core App。

当前示例的 focused checks 是：

```sh
bun run --cwd examples/healthcare-appointments typecheck
bun run --cwd examples/healthcare-appointments test:unit
```

示例还声明了一个 E2E wrapper：

```sh
bun run --cwd examples/healthcare-appointments test:e2e
```

该命令会构建并运行 example E2E task。它是一个待执行的命令，不表示当前 checkout 已经通过。

## M0：先写领域规则

领域模块即使使用的内存 repository 关键区段是同步的，也应该采用 Context-first 形式。这样取消能力和未来替换 provider 的边界都可见：

```ts
import type { Context } from "@go-like/context"

export interface BookAppointmentCommand {
  readonly appointmentId: string
  readonly doctorId: string
  readonly patientId: string
  readonly startsAt: number
  readonly endsAt: number
}

export type AppointmentStatus = "booked" | "cancelled"

export interface Appointment extends BookAppointmentCommand {
  readonly status: AppointmentStatus
}

export interface AppointmentRepository {
  book(ctx: Context, command: BookAppointmentCommand): Appointment
  cancel(ctx: Context, appointmentId: string): Appointment
  get(ctx: Context, appointmentId: string): Appointment | undefined
}
```

Repository 在修改状态前应该检查 `ctx.err()`。当前示例的 `newMemoryAppointmentRepository()` 会这样做，并为每个 appointment 保存 fingerprint。它使用下面的 overlap predicate：

```ts
function overlaps(
  leftStartsAt: number,
  leftEndsAt: number,
  rightStartsAt: number,
  rightEndsAt: number
): boolean {
  return leftStartsAt < rightEndsAt && rightStartsAt < leftEndsAt
}
```

这个 predicate 允许相邻预约，但会让同一位医生的 active appointments 在重叠时失败。取消会把保存的 status 改成 `cancelled`；再次取消会返回同一条已取消记录。

### M0 测试

在加入 HTTP 或 transport 前，先写这些测试：

```ts
import { background } from "@go-like/context"
import { expect, test } from "bun:test"

// The concrete repository factory is the one in src/service.ts.
test("rejects an overlapping active slot", () => {
  const repository = newMemoryAppointmentRepository()
  const book = newBookAppointment(repository, () => 1_000)
  book(background(), {
    appointmentId: "a-1",
    doctorId: "doctor-1",
    patientId: "patient-1",
    startsAt: 2_000,
    endsAt: 3_000
  })

  expect(() =>
    book(background(), {
      appointmentId: "a-2",
      doctorId: "doctor-1",
      patientId: "patient-2",
      startsAt: 2_500,
      endsAt: 3_500
    })
  ).toThrow("doctor time conflict")
})
```

当前 `test/main.test.ts` 已经包含这个用例，以及取消复用、幂等取消和 HTTP handler 检查。在你的环境中执行上面的命令前，这些测试只是已经检查过的 repository evidence。

## M1：一个 typed internal policy service

typed internal contract 使用 `@go-like/struct` 和 `@go-like/transport`。这是 unary Message 边界上的 runtime validation，不是 IDL 或 generated RPC service。

### `src/contract.ts`

```ts
import { struct, type Infer } from "@go-like/struct"
import { endpoint } from "@go-like/transport"

const CheckRequest = struct.object({
  appointmentId: struct.string(),
  doctorId: struct.string(),
  patientId: struct.string(),
  startsAt: struct.number(),
  endsAt: struct.number()
})

const CheckResponse = struct.object({
  allowed: struct.boolean()
})

export type CheckRequest = Infer<typeof CheckRequest>
export type CheckResponse = Infer<typeof CheckResponse>

export const checkAppointment = endpoint(
  "appointment-policy",
  "AppointmentPolicy.Check",
  CheckRequest,
  CheckResponse
)
```

route tokens 使用可见 ASCII，并且不能包含 `/` 或 `*`。`Endpoint` 包含 request 和 response Struct 实例，以及两个 route token。它不描述网络地址，也不代表生成式 client。

### `src/transport.ts`

```ts
import { newClient, withAddress, withTransport } from "@go-like/client"
import type { Context } from "@go-like/context"
import {
  address,
  handler,
  newServer,
  transport as serverTransport,
  type Server
} from "@go-like/server"
import { newMemoryTransport } from "@go-like/transport-memory"

import { checkAppointment, type CheckRequest, type CheckResponse } from "./contract"

const policyAddress = "memory://appointment-policy"

export interface AppointmentPolicy {
  readonly server: Server
  validate(ctx: Context, request: CheckRequest): Promise<CheckResponse>
  close(ctx: Context): Promise<void>
}

export function newAppointmentPolicy(maximumDurationMs = 7_200_000): AppointmentPolicy {
  const transport = newMemoryTransport()
  const client = newClient(withTransport(transport))
  const server = newServer(
    serverTransport(transport),
    address(policyAddress),
    handler(checkAppointment, (_ctx, request) => {
      if (request.endsAt - request.startsAt > maximumDurationMs) {
        throw new Error("appointment duration exceeds policy")
      }
      return { allowed: true }
    })
  )

  return Object.freeze({
    server,
    async validate(ctx: Context, request: CheckRequest): Promise<CheckResponse> {
      return await client.call(ctx, checkAppointment, request, withAddress(policyAddress))
    },
    close(ctx: Context): Promise<void> {
      return client.close(ctx)
    }
  })
}
```

当前已提交的示例使用 raw `Message` policy handler，以及 status 为 `409` 的 `serviceError(...)`。这是有效的低层边界。上面的 typed 版本改变的是 request 和 response codec，不是核心所有权模型：一个 Memory Transport 实例、一个内部 Server、一个 Client，以及显式 close。

### 继续传递 Context

预约 use case 应该把同一个 request Context 传给 policy Client 和 repository：

```ts
async function validatedBook(ctx: Context, command: CheckRequest): Promise<Appointment> {
  await policy.validate(ctx, command)
  return repository.book(ctx, command)
}
```

用 `background()` 替换 `ctx` 会丢掉 request deadline、取消信号和 Context ancestry。这是 correctness regression，不是无害的简化。

### M1 测试

至少测试以下内容：

| 测试                   | 预期结果                                           |
| ---------------------- | -------------------------------------------------- |
| valid typed request    | `allowed: true`，并创建 booked appointment         |
| overlong request       | 在 repository mutation 之前失败                    |
| invalid field type     | typed request decode failure                       |
| invalid response shape | Server boundary 处的 typed response encode failure |
| canceled Context       | policy 和 repository 观察到同一个 cancellation     |
| client close           | resident Transport Client 的 cleanup 是显式的      |

当前示例的 policy test 已经验证了在 repository mutation 前拒绝，以及通过 `Client -> Memory Transport -> Server` 成功调用。typed test 是建议增加的扩展。

## M2：availability Cache

Cache 适合做读取投影，不适合做预约权威来源。Cache package 提供 Context-first 的 `get`、`put` 和 `delete`；`@go-like/cache-memory` 提供 `newMemoryCache()`，`@go-like/cache` 提供 `expiresIn(...)`：

```ts
import { expiresIn } from "@go-like/cache"
import { newMemoryCache } from "@go-like/cache-memory"

const availabilityCache = newMemoryCache()

async function readAvailability(ctx: Context, doctorId: string) {
  const key = `availability/${doctorId}`
  const cached = await availabilityCache.get(ctx, key)
  if (cached !== null) {
    return JSON.parse(new TextDecoder().decode(cached)) as Availability
  }

  const authoritative = repository.readAvailability(ctx, doctorId)
  await availabilityCache.put(
    ctx,
    key,
    new TextEncoder().encode(JSON.stringify(authoritative)),
    expiresIn(30_000)
  )
  return authoritative
}

async function invalidateAvailability(ctx: Context, doctorId: string): Promise<void> {
  await availabilityCache.delete(ctx, `availability/${doctorId}`)
}
```

`repository.readAvailability(...)` 是本教程中由应用拥有的方法，不是 go-like export。Booking 和 cancellation 都必须在权威 mutation 后删除这个 key。如果失效操作失败，应该报告失败并选择明确的一致性策略；不要静默地把 cache 当成预约事实来源。

### M2 测试

- miss 会读取 repository 并填充 cache；
- hit 不会再次读取 repository；
- booking 或 cancellation 会删除 projection；
- 过期值会回退到 repository；
- cache failure 不会把正确的 authoritative read 变成错误的 booking result；
- 进程重启会按设计丢失 Memory Cache 状态。

## M3：liveness 与 readiness

在 composition root 创建 registry，并把两个路径委托给 `createHealthHandler(...)`：

```ts
import { createHealthHandler } from "@go-like/web/health"
import { newProbeRegistry } from "@go-like/health"
import type { Handler } from "@go-like/web"

const probes = newProbeRegistry()
probes.register("ready", "policy", async (ctx) => {
  await policy.server.endpoint(ctx)
})

const healthHandler = createHealthHandler(probes)
const appointmentHandler: Handler = newAppointmentHandler(book, cancel)

const webHandler: Handler = (request) => {
  const path = new URL(request.url).pathname
  if (path === "/livez" || path === "/readyz") return healthHandler(request)
  return appointmentHandler(request)
}
```

默认路由是 `/livez` 和 `/readyz`。空的 liveness 是 healthy；空的 readiness 则 fail closed。上面的 `policy` probe 让 readiness 依赖内部 listener admission，但不会假装外部数据库总是等同于进程 liveness。

生产服务只应该把真正的流量前置依赖加入 readiness。Probe name 是 public identifier，health payload 会刻意做脱敏处理。

## M4：一个生命周期所有者

Composition root 应该只构造一次资源，并把它们放进同一个 App：

```ts
import process from "node:process"
import { afterStart, afterStop, name, newApp, server } from "@go-like/core"
import { signal } from "@go-like/core/node"
import { hostname, newNodeServer, port } from "@go-like/web/node"

const policy = newAppointmentPolicy()
const httpServer = newNodeServer(webHandler, hostname("127.0.0.1"), port(3000))
const app = newApp(
  signal(),
  name("healthcare-appointments"),
  server(policy.server, httpServer),
  afterStart(async (ctx) => {
    await httpServer.endpoint(ctx)
    process.stdout.write("GO_LIKE_EXAMPLE_READY=healthcare-appointments\n")
  }),
  afterStop((ctx) => policy.close(ctx))
)

await app.run()
```

`afterStop` hook 是 policy Client 的一个显式顺序边界。Core 本身会并发停止 sibling Servers。如果依赖更复杂，需要严格顺序，就把相关资源组合进一个 Server 或显式 hook，不要依赖声明顺序。

`signal()` 是 Node/Bun process adapter。领域代码、typed contract、Memory Transport 和 health modules 可以保持可移植；导入 `@go-like/core/node` 是一个有意的 runtime 选择。

## M5：测试计划与证据

| 层次       | 测试                                                               | 证据目标                                        |
| ---------- | ------------------------------------------------------------------ | ----------------------------------------------- |
| Domain     | overlap、cancellation reuse、idempotency、conflicting ID           | `src/service.ts` 行为和 unit test 结果          |
| Context    | canceled booking 不会修改 repository，也不会调用 policy            | focused Context test                            |
| Typed call | Struct decode/encode、policy rejection、response validation        | `@go-like/client` 和 `@go-like/server` boundary |
| Cache      | miss、hit、TTL、invalidation、failure fallback                     | `newMemoryCache()` tests                        |
| Health     | empty liveness、empty readiness、failing probe、405/404            | `newProbeRegistry()` 和 `createHealthHandler()` |
| HTTP       | `POST`、`DELETE`、invalid JSON、conflict status                    | standard Fetch Handler test                     |
| Lifecycle  | policy 和 Web Server 在同一个 App 下被 admitted；显式 close Client | Core App 和 Server terminal behavior            |
| Node E2E   | real bind、request、signal、stop、port release                     | example E2E wrapper 和 residual checks          |

当前 repository example 的 focused commands 是：

```sh
bun run --cwd examples/healthcare-appointments typecheck
bun run --cwd examples/healthcare-appointments test:unit
bun run --cwd examples/healthcare-appointments test:e2e
```

整个 examples lane：

```sh
bun run test:e2e:examples
```

完整 E2E lane 会构建 packages 并使用 repository runner。Docker providers 和 cross-runtime consumers 属于不同范围。请记录 candidate commit、runtime versions、exit status、summary 以及残留进程或 container；脚本存在不等于执行通过。

## 里程碑

| 里程碑 | 交付物                                         | 何时进入下一步                                           |
| ------ | ---------------------------------------------- | -------------------------------------------------------- |
| M0     | Domain repository 和 invariant tests           | overlap 与 cancellation 行为是确定的                     |
| M1     | 通过 Memory Transport 的 typed policy Endpoint | 调用确实经过 Client/Server/Transport，而不是直接函数调用 |
| M2     | 带 invalidation 的 cache projection            | cache failure 不会取代 authority                         |
| M3     | `/livez` 和 `/readyz`                          | 已理解空 readiness 与 failing probes                     |
| M4     | 一个 App、signal、显式 Client cleanup          | 每个 admitted resource 都有一个 owner                    |
| M5     | Unit 和 Node E2E evidence                      | 结果已带 command 和 exit status 记录                     |

在这些里程碑清楚之前，不要加入 Registry、Redis、Vault、真实 Broker、authentication 或 retries。每一项都会增加新的所有权或故障模型，应该有意识地引入。

## 故障排查

### `Cannot find package "@go-like/..."`

你可能在 workspace 外运行，或者正在依赖尚未发布的 package。请从 repository 根目录执行 `bun install --frozen-lockfile`，并运行 workspace script，例如 `bun run --cwd examples/healthcare-appointments start`。

### 请求返回 `404`

当前示例只暴露 `POST /v1/appointments` 和 `DELETE /v1/appointments/{appointmentId}`。检查 method、path 和 `GO_LIKE_EXAMPLE_READY` 行。Health routes 属于 M3 tutorial extension，不在当前已提交示例中。

### 请求返回 `400`

示例要求 ID 是字符串，`startsAt`/`endsAt` 是数字。相对于注入的 clock，`startsAt` 必须在未来，并且 `endsAt` 必须大于 `startsAt`。确认 shell arithmetic 生成的是数字，而不是带引号的字符串。

### 请求返回 `409`

可能是医生时间段与 active appointment 重叠、appointment ID 被不同内容复用，或者 policy service 拒绝了预约时长。policy 在 repository mutation 前调用，因此 policy rejection 不应该创建记录。

### `Endpoint` typed call 报告 invalid request 或 response body

检查 client 和 server 是否使用同一个 Endpoint Structs，并确认 request Content-Type 正好是 `application/json`。`handler(contract, fn)` 会在 Server boundary 做 JSON 和 Struct validation。

### Memory Client 无法连到 Server

`newMemoryTransport()` 创建的是实例私有的 address map。Client 和 Server 必须共享同一个 Transport 实例，并且绑定的 `memory:` address 完全一致。在两个分别构造的 Memory Transport 实例中使用相同 URL，并不会连通。

### `app.run()` 看起来卡住了

长期运行的 `Server.start(ctx)` 可能会一直 pending，直到服务生命周期结束，这是预期行为。`app.run()` 会在 stop 和终态 cleanup 后 resolve，不会在 listener 刚绑定后立即 resolve。用 `afterStart` 或 `server.endpoint(ctx)` 观察 admission signal。

### Stop 返回 timeout 或 aggregate error

timeout 限制的是调用方等待 cleanup 的时间，不代表原生资源已经停止；sibling Servers 会并发停止。在判断 shutdown 是否干净前，请检查 primary error、adapter terminal barrier 以及残留进程或 socket 证据。

### Cache 数据消失了

`@go-like/cache-memory` 是进程内且可丢弃的。权威记录应使用明确的 Store provider，并记录其实际 durability 和 ownership；不要把 Cache 当成数据库。

## 边界回顾

这个项目用一条真实但保持小巧的路径教你使用 go-like：

```text
Request
  -> standard Fetch Handler
  -> Context-first appointment use case
  -> typed Client call
  -> Memory Transport
  -> unary Server policy handler
  -> canonical appointment repository
  -> disposable availability Cache
  -> Response

App.stop()
  -> deregistration if configured
  -> concurrent Server stop
  -> explicit Client / provider cleanup
  -> terminal result
```

它不涉及 gRPC、Protobuf、IDL generation、内部全双工 streams、分布式锁、持久化消息或生产级 authentication。这些属于小项目之外的独立设计决策。
