# 架构

go-like 是一层组合。`@go-like/core` 声明插座，并实现那些不需要第三方客户端的机制。插头填入插座。应用构造原生对象，建成插头，再决定哪个 App 层级拥有它。

有用的问题是：谁接纳这个对象，它坐在哪一层，谁观察它的终态，哪个 runtime 或后端赋予这个结果意义？

## 插座与插头

```text
应用组合根
  |
  +--> Context、metadata、struct、健康检查、韧性     core 机制
  |
  +--> 生命周期
  |      telemetry(tel) -> resources(...) -> server(...) -> registrar
  |
  +--> 对外 Web
  |      Handler 在 @go-like/core/web
  |      宿主在 @go-like/core/web/node 或 @go-like/core/web/bun
  |
  +--> 内部调用
  |      Client、Server、Transport
  |      memory 与 Fetch 传输在 core；gRPC 在 @go-like/connectrpc
  |
  +--> 状态
  |      Config、Registry、Store、Cache 插座
  |      memory 参考实现在 core；Consul、etcd、Vault、Kubernetes、
  |      ZooKeeper、mDNS、YAML、Redis 和文件插头
  |
  +--> 消息与任务
  |      Broker 与 Job 插座
  |      memory broker 在 core；NATS、RabbitMQ、BullMQ 和 Croner 插头
  |
  +--> 观测插座
         LogHandler、TracerProvider、MeterProvider、Propagator
         由 @go-like/otel、@go-like/pino/log、@go-like/winston/log、
         @go-like/prometheus/metric 填入
```

Core 在固定调用点记录每个工作单元。插头不会包裹 `newClient` 或 Web handler 来加 span。core 内部的导入方向由 `test/portable-lane.test.ts` 强制：更低的层不导入根入口。

## 三个层级

`newApp(...options)` 按参数顺序应用选项。同一个对象不能同时出现在 `resources(...)` 和 `server(...)` 里。把 `Telemetry` bundle 传给其中任一列表，既是类型错误，也是运行时 `TypeError`。

| 层级      | 选项                               | 启动                                                                                                                       | 停止                                                                                                           |
| --------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Telemetry | `telemetry(tel)` 替换上一份 bundle | 最先。先是日志 handler，然后是 tracer，再是 meter。每个 `lifecycle.start` 都会检查是否立即失败。失败会回滚已经启动的那些。 | 最后，在 `afterStop` 之后，使用它自己的一份 `stopTimeout` 预算。Tracer 和 meter 一起排空，然后是日志 handler。 |
| Resources | `resources(...)` 替换上一份列表    | 在 `beforeStart` 之后、任何 server 之前。按声明顺序。每个 `start(ctx)` 都会被 await，并且必须在资源可用时 resolve。        | 在每个已启动的 server 都停止之后，按声明的相反顺序。一次停止失败会被记录，下一个资源仍会停止。                 |
| Servers   | `server(...)` 替换上一份列表       | 先发出全部 `start` 调用，再做一次立即失败检查。`start` 可以一直 pending，直到原生对象结束。可选 `Endpointer`。             | 并发 `stop`，然后 join 每个 `start` promise。                                                                  |

Hook：`beforeStart` 在资源层之前运行。`afterStart` 在注册之后运行。`beforeStop` 在注销之前运行。`afterStop` 在资源层之后、观测排空之前运行。启动 hook 失败即停。停止 hook 作为清理运行。

注册只使用 server 层。资源是依赖，不是要对外公布的地址。

```text
run()
  1  安装 signal() 或其他 runtime 选项
  2  phase = starting
  3  接纳 telemetry
  4  若设置了 startTimeout，打开启动预算
  5  beforeStart
  6  接纳每个资源并等待
  7  启动每个 server，然后检查是否立即失败
  8  准备 endpoint 并注册，仅 server 层
  9  afterStart
 10  phase = ready；go_like.app.ready 与就绪探针同时翻转
 11  等待停止，或第一个参与者失败

stop()
  1  phase = stopping；就绪探针从这一刻起失败
  2  若设置了 stopTimeout，打开共享的停止预算
  3  取消应用 Context
  4  在该预算内 join 启动
  5  beforeStop
  6  注销
  7  取消 server Context，并并发停止已启动的 server
  8  join server 的 start promise
  9  取消资源 Context，并按相反顺序停止已拥有的资源
 10  在同一份预算内 join 资源的 start promise
 11  afterStop
 12  取消 telemetry Context，并在一份同样长度的新预算上停止该 bundle
```

`run()` 只运行一次。`stop()` 幂等，并共享同一个 promise。`App.stop()` 不接收 Context。第一个停止原因胜出：`App.stop()` 和 `signal()` 是 `requested`，父 Context 结束时是 `context_canceled`，启动失败是 `start_failed`，就绪之后已接纳的参与者失败是 `server_failed`。一次失败按原样抛出。多次失败按阶段顺序收成一个 `AggregateError`，telemetry 在最后。

兄弟 server 没有反向顺序保证。如果 worker 必须在它的队列之前停止，把队列放进 `resources(...)`，把 worker 放进 `server(...)`。资源层的存在，就是为了让这种组合等待接纳。手写的 `Server` 如果 `start` 永不 resolve，会卡住资源接纳；原生对象用 `newResourceServer`，或把长期参与者放进 `server(...)`。

## Context 作用域

```text
parent
  -> appContext          在 stop 开始时取消
       -> telemetryContext    就在 Telemetry.stop 之前取消
       -> resourceContext     就在资源层停止之前取消
       -> serverContext       就在 Server.stop 之前取消
       -> startContext        appContext，配置了 startTimeout 时再加上它
       -> stopContext         withoutCancel(appContext)，加上共享的 stopTimeout
       -> telemetryStop       第二份 stopTimeout，在排空开始时打开
```

长期运行的 `start(ctx)` 收到它自己那一层的 Context。该 Context 一直活到这一层被要求停止，因此资源在 server 仍在排空时看不到取消。Telemetry 使用自己的 Context，原因相同：在 stop 一开始就取消 `appContext`，不能在它所观察的 server 之前排空 telemetry。

## 预算与所有权

`startTimeout` 覆盖 hook、资源接纳、endpoint 准备、注册和 `afterStart`。它不覆盖 telemetry 接纳，也不会把 server 的 `start` 变成就绪 promise。默认 `0` 表示没有限制。`registrarTimeout` 默认 10 秒，限制 register 和 deregister 调用。

`stopTimeout` 是 hook、注销、server 层和资源层共享的调用方等待预算。观测排空在该阶段开始时打开第二份同样长度的预算，因此共享预算耗尽之后，导出仍可以完成。一次永不结算的排空会使 `App.run()` 等待大约两倍的 `stopTimeout`。默认 `0` 表示两者都没有限制。共享预算已经耗尽时，后面的 `stop` 调用仍会发出。Core 不再继续等待，超时也不是原生终态。插头自己的超时留在插头上：OpenTelemetry 停机默认 25 秒，Pino 排空默认 25 秒，Winston handler 自己没有排空超时。

`start` resolve 之后，App 拥有该参与者。`newResourceServer({ open, terminal, close })` 在 `open` 结束时 resolve `start`；省略 `open` 时立即 resolve。`close` 是唯一的所有者排空，并用第一次停止 Context 的 `withoutCancel` 调用。`open` 失败时不调用 `close`。第二次 `start` 以 `GO_LIKE_RESOURCE_ALREADY_STARTED` 拒绝。在停止之前，干净的 `terminal` 结算会使 App 以 `GO_LIKE_RESOURCE_CLOSED` 失败。`Error` resolution 或 rejection 会使 App 以该错误失败。terminal promise 被私下观察；它不是公共插座字段。

## 就绪

`readyProbe(registry, name?)` 注册一个同步探针，默认名称是 `"app"`。它只在 `run()` 处于 ready 阶段时通过，并与 `go_like.app.ready` 仪表同时翻转。窗口之外它抛出 `AppNotReadyError`（`GO_LIKE_APP_NOT_READY`），`phase` 为 `created`、`starting`、`stopping` 或 `stopped`。`run()` 结算之后，探针被移除。从未运行过的 App 保持 `created`。

`createHealthHandler(probes)` 投影出 `/livez` 和 `/readyz`。空的存活检查通过。空的就绪检查 fail closed，因此没有 `readyProbe` 或其他就绪探针的 handler 对 `/readyz` 返回 503。每个已注册的就绪探针都必须通过。Core 不注册存活探针。

内部 `newServer` 监听器仍然对 `GET` 和 `HEAD` `/healthz` 回答空的 200。该响应表示 unary 监听器接纳了这次请求。它不是探针 registry。

## 监听器与发布端口

绑定 `127.0.0.1` 再调用该地址的示例，是正确的本地形态。Docker 发布端口可以在容器开始提供协议之前，就通过代理接受 TCP。当启动的拓扑是 Compose 网络时，通过服务 DNS 访问 Redis、AMQP、etcd 和应用 HTTP。

server 层上的 `Server.start(ctx)` 不表示就绪。`Endpointer.endpoint(ctx)` 返回一个可以对外公布的地址。`afterStart` 表示 Core 到达了这个 hook。

`startRecoveringRabbitMqBroker` 可以在 connector 设置完成之前接纳一个 broker 句柄，因此 HTTP 可以不等待 AMQP 就绑定。在某一代存在之前，发布保持关闭。这是句柄的接纳，不是健康检查路由。

## 请求路径

```text
对外 Web
  Request -> 框架或 Handler -> Response -> 宿主写出 body

内部 unary
  Context + operation
    -> Client middleware
    -> 直接地址或 Discovery 快照
    -> Filter，然后 Selector
    -> Transport
    -> POST /<service>/<endpoint>
    -> Server middleware、Struct 解码、handler、Struct 编码
```

操作身份是 `service/endpoint`，例如 `appointment-policy.v1/check`。`ServiceInstance` 的 endpoint 是不透明的传输地址，例如 `memory://orders` 或 `https://orders.example`。

## Runtime 可移植性

可移植入口使用标准 JavaScript 和 Web API，或调用方注入的能力。可移植入口不承诺 TCP 监听器、进程信号、文件监视、UDP 组播或厂商客户端。

| 入口                                                                                          | 运行位置                                                       |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `@go-like/core` 的概念入口，包括 `/web`、`/transport/http`、`/transport/memory`               | 可移植。`/transport/http` 用 Fetch 拨号。监听需要注入的宿主。  |
| `@go-like/core/node`、`/transport/http/node`、`/web/node`、`/config/node`                     | Node API。`/web/node` 也可以在这些 API 存在的地方运行。        |
| `@go-like/core/web/bun`                                                                       | Bun 宿主。                                                     |
| `@go-like/mdns/registry/node`、`@go-like/zookeeper/registry/node`、`@go-like/file/store/node` | 该插头的 Node 宿主。兄弟入口在注入的宿主或工厂之上保持可移植。 |
| `@go-like/connectrpc`                                                                         | 可移植的 Fetch handler。                                       |
| `@go-like/connectrpc/node`                                                                    | Node gRPC 服务端和客户端。                                     |
| NATS、RabbitMQ、Redis、BullMQ                                                                 | Node 和 Bun，跟随原生客户端。                                  |

包导出不使用有条件的 `bun` 或 `node` condition。导入你要的那个子路径。TypeScript 的 `DOM` 库提供类型。它不是 runtime polyfill。

## 组合

```ts
import { newClient, withEndpoint, withTransport } from "@go-like/core/client"
import { afterStop, name, newApp, server } from "@go-like/core"
import { signal } from "@go-like/core/node"
import { address, newServer, transport as serverTransport } from "@go-like/core/server"
import { struct } from "@go-like/core/struct"
import { defineService } from "@go-like/core/transport"
import { newMemoryTransport } from "@go-like/core/transport/memory"
import { newNodeServer, port } from "@go-like/core/web/node"

const policy = defineService("policy", {
  check: {
    request: struct.object({ ok: struct.boolean() }),
    response: struct.object({ ok: struct.boolean() })
  }
})

const transport = newMemoryTransport()
const policyServer = newServer(serverTransport(transport), address("memory://policy"))
policy.registerHandler(policyServer, {
  check() {
    return { ok: true }
  }
})
const policyClient = newClient(withTransport(transport), withEndpoint("memory://policy"))
const webServer = newNodeServer((_request: Request) => new Response("ok"), port(3000))

const app = newApp(
  name("appointments"),
  server(policyServer, webServer),
  afterStop(async (ctx) => {
    await policyClient.close(ctx)
  }),
  signal()
)
void app
```

`newApp` 不会变成容器，memory transport 也不会变成网络。凭据、工厂，以及没有交给 App 的对象的停机，留在组合根里。

更早的设计笔记使用 `ServerHandle`、`AppHandle` 这样的名字。本页上的签名才是今天导出的签名。`Server` 和 `Endpointer` 从 `@go-like/core/lifecycle` 导出，不从根入口导出。
