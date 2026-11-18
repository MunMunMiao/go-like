# 诊所预约：从 0 到 1

这条路径让一条业务不变量穿过内部策略调用、Fetch handler、健康检查和一个 App。可运行的树是 `examples/healthcare-appointments`。下面的片段使用该示例的名字。可丢弃的可预约缓存是在同一个组合根里额外加上的里程碑。它不是第二份事实来源。

## 不变量

1. 一名医生不能有重叠的有效预约。
2. 取消会释放时段。
3. 用相同内容重复同一个预约 id 是幂等的。
4. 用不同内容复用一个预约 id 会被拒绝。
5. 如果加上了缓存的可预约投影，它本身从不授权一次预约。

示例用内存仓库实现前四条规则，并通过 `appointment-policy.v1/check` 检查最大时长。它不声称有数据库、分布式锁、认证或生产诊所流程。

## 布局

```text
examples/healthcare-appointments/
  src/contract.ts    defineService 与 Struct
  src/service.ts     仓库与预约规则
  src/transport.ts   memory Server 与 Client
  src/http.ts        Fetch handler
  src/main.ts        Node 宿主与 App
  test/main.test.ts
```

在仓库根目录：

```sh
bun install --frozen-lockfile
bun run --cwd examples/healthcare-appointments test:unit
```

包版本 `0.0.1` 不能证明 npm 可用。在此 checkout 内，该示例需要的唯一 go-like 依赖是 `@go-like/core`。

## M0：领域规则

`src/service.ts` 拥有 `BookAppointmentCommand`、仓库和重叠检查。即使内存仓库不阻塞，Context 也是第一个参数。以后的 store 或 cache 可以使用同一个签名。

示例拒绝错误的 id、非正的时间窗、重叠，以及用不同内容复用的 id。这些用例的测试放在仓库旁边，没有 App，也没有 HTTP。

## M1：策略服务

`src/contract.ts` 绑定操作：

```ts
import { struct } from "@go-like/core/struct"
import { defineService } from "@go-like/core/transport"

const command = struct.object({
  appointmentId: struct.string(),
  doctorId: struct.string(),
  patientId: struct.string(),
  startsAt: struct.number(),
  endsAt: struct.number()
})

export const appointmentPolicy = defineService("appointment-policy.v1", {
  check: {
    request: command,
    response: struct.object({ allowed: struct.literal(true) })
  }
})
```

`src/transport.ts` 把两端放在同一个 memory transport 上。地址 `memory://appointment-policy.v1` 不是操作名。

```ts
import { newClient, withEndpoint, withTransport } from "@go-like/core/client"
import { address, newServer, transport as serverTransport } from "@go-like/core/server"
import { serviceError } from "@go-like/core/transport"
import { newMemoryTransport } from "@go-like/core/transport/memory"
import { appointmentPolicy } from "./contract"

const transport = newMemoryTransport()
const server = newServer(serverTransport(transport), address("memory://appointment-policy.v1"))
appointmentPolicy.registerHandler(server, {
  check(_ctx, command) {
    if (command.endsAt - command.startsAt > 7_200_000) {
      throw serviceError("appointment_policy_rejected", "appointment duration exceeds policy", 409)
    }
    return { allowed: true as const }
  }
})
const caller = appointmentPolicy.newClient(
  newClient(withTransport(transport), withEndpoint("memory://appointment-policy.v1"))
)
```

`src/http.ts` 是一个 `contextHandler`。它把请求 Context 转发进预约和取消。HTTP 400 是畸形 body。HTTP 409 是被拒绝的预约。这些状态是 Web handler 的选择。策略失败是内部调用上状态为 409 的 `ServiceError`。

## M2：可预约缓存

内存缓存是可选的，并且只在进程内。键和值是字节。仓库保持权威：命中则跳过一次读取，未命中或过期则再读一次，预约或取消会删除该键。缓存错误不能变成一次成功的预约。

```ts
import { expiresIn } from "@go-like/core/cache"
import { newMemoryCache } from "@go-like/core/cache/memory"

const cache = newMemoryCache()
await cache.put(ctx, key, bytes, expiresIn(5_000))
const hit = await cache.get(ctx, key)
```

`newMemoryCache` 不是 `Server`。`@go-like/redis/cache` 是 `Server`；那个要放进 `resources(...)`。

## M3：存活与就绪

创建一个 registry，让 App 指向它，并自己分发 `/livez` 和 `/readyz`。没有 `readyProbe` 时，`/readyz` 保持 503。

```ts
import { newApp, readyProbe, server } from "@go-like/core"
import { newProbeRegistry } from "@go-like/core/health"
import { createHealthHandler, type Handler } from "@go-like/core/web"

const probes = newProbeRegistry()
probes.register("ready", "policy", async (ctx) => {
  await policyServer.endpoint(ctx)
})
const health = createHealthHandler(probes)

const handler: Handler = async (request) => {
  const { pathname } = new URL(request.url)
  if (pathname === "/livez" || pathname === "/readyz") return await health(request)
  return appointmentHandler(request)
}

const app = newApp(readyProbe(probes), server(policyServer, web))
void handler
void app
```

## M4：一个生命周期所有者

示例里的 `src/main.ts` 是组合根：仓库、策略服务、handler、`newNodeServer`、`signal()`，以及在写出 `GO_LIKE_EXAMPLE_READY` 之前等待 `endpoint(ctx)` 的 `afterStart`。暴露 `/readyz` 时加上 `readyProbe`。如果策略客户端比 memory server 活得更久，在 `afterStop` 里关闭它。

```ts
import { afterStart, name, newApp, server } from "@go-like/core"
import { signal } from "@go-like/core/node"
import { hostname, newNodeServer, port } from "@go-like/core/web/node"

const httpServer = newNodeServer(handler, hostname(host), port(portNumber))
const app = newApp(
  signal(),
  name("healthcare-appointments"),
  server(policy.server, httpServer),
  afterStart(async (ctx) => {
    await httpServer.endpoint(ctx)
  })
)
await app.run()
```

`server(...)` 一起启动两个参与者。策略 server 在进程内，所以它不需要资源层。Redis 缓存或文件存储则需要。

## M5：测试确立了什么

`test/main.test.ts` 演练内存规则和内部调用。一次通过的单元测试不能确立 Docker、已发布的 tarball 或生产预约系统。如果要声称一个结果，记下命令。见[验证](/zh-Hans/reference/verification)。

## 排查

| 现象                  | 检查                                                                  |
| --------------------- | --------------------------------------------------------------------- |
| `Cannot find package` | 运行 `bun install --frozen-lockfile`。Import 是 `@go-like/core/...`。 |
| HTTP 404              | Handler 不认识该路径。健康检查路由不会被替你挂上。                    |
| HTTP 400              | JSON body 没有通过 handler 自己的检查。                               |
| HTTP 409              | 仓库或策略拒绝了这条命令。                                            |
| 带类型的调用校验失败  | 请求或响应与 Struct 不匹配。                                          |
| 客户端到不了服务端    | 客户端和服务端必须共享同一个 `newMemoryTransport()` 实例。            |
| `app.run()` 不返回    | 它一直等到停止。`signal()` 或 `app.stop()` 结束它。                   |
| `EADDRINUSE`          | 端口已被占用。                                                        |
| 缓存值消失了          | 内存缓存只在进程内。TTL 和 `delete` 也会去掉它。                      |
| `/readyz` 是 503      | 注册一个就绪探针，包括 `readyProbe(probes)`。                         |
