# @likego/pino

`@likego/pino` 把应用创建的 Pino destination 接入 LikeGo `Server` 生命周期，并为 Client、内部
Server、标准 Web Handler 和 Broker 提供薄请求日志包装。Pino 继续拥有
logger、level、custom levels、formatter、redaction、bindings、child logger、destination 和 transport 的
全部业务语义；该包不复制或配置这些能力。

## 使用方式

```ts
import pino from "pino"
import { newApp, server } from "@likego/core"
import { newPinoServer } from "@likego/pino"

const destination = pino.destination({
  dest: "/var/log/orders/service.log",
  sync: false,
  mkdir: true
})
const logger = pino(
  {
    level: "info",
    redact: ["password", "token"]
  },
  destination
)

// App 启动并接纳 logging Server 后，destination 的 flush/end/close 生命周期移交给 LikeGo。
const logging = newPinoServer(logger, destination)
const app = newApp(server(logging, httpServer))

const running = app.run()
logger.info({ service: "orders" }, "service ready")
await app.stop()
await running
```

## 请求日志

```ts
import { logBroker, logClient, logUnaryMiddleware, logWebHandler } from "@likego/pino"

const clientWithLogs = logClient(client, logger)
const unaryLogging = logUnaryMiddleware(logger)
const webWithLogs = logWebHandler(webHandler, logger)
const brokerWithLogs = logBroker(broker, logger)
```

每次逻辑操作只生成一条完成日志。固定字段是 `component`、`operation`、`outcome` 和
`durationMs`；Web 响应增加 `httpStatus`。失败只可增加格式为
`^[A-Za-z][A-Za-z0-9_.-]{0,63}$` 的 `errorType`，以及格式为
`^[A-Z0-9_.-]{1,64}$` 的 `errorCode`。非法、过长或读取失败的字段会被省略。成功与取消使用 Pino
`info`，失败使用 Pino `error`。操作名保持有限边界：

- Client 和内部 Server：`service/endpoint`；Server 只读取 `Likego-Service` 与
  `Likego-Endpoint` 保留路由头。
- Web：HTTP method，不包含 URL 或 path。
- Broker：`publish topic` 或 `consume topic`。

包装器不记录原始 Error、message、stack、cause、body、headers、metadata、URL path 或 topic payload，
也不取得 Client、Broker、Subscriber 或 Handler 的生命周期所有权。需要记录原始错误时，应用应在自己的
原生 Logger 边界显式处理。原生 receiver、Client/Broker 返回值、Subscriber 对象，以及 Web Handler 同步或
异步返回方式保持不变。

应用始终直接持有并使用官方 `pino.Logger`。`newPinoServer` 只验证 logger 通过 Pino 公开的
`symbols.streamSym` 绑定了同一个 destination；`start(ctx)` 的同步准入完成前 destination 仍由应用拥有，也不会
留下适配器监听器。接纳后，应用不得再调用 destination 的 `end()` 或 `destroy()`；一个原生资源只能
有一个生命周期 owner。应用可以继续用 logger 写记录，但不得替换 logger 的 `flush`/stream binding 或
destination 的 lifecycle 方法。adapter 使用构造期捕获、start 准入确认的固定 `flush`/`end`/`destroy` 引用；若 logger
stream 之后漂移，会跳过错配 flush、清理原 destination 并以失败结算，绝不会把错配资源报告为成功 terminal。
无需 LikeGo 管理的 logger 直接使用 Pino 即可，不需要额外包装。

公开类型边界直接接收官方 `pino.Logger`，以及 `pino.destination()` 或 `pino.transport()` 的官方返回类型。
该包不导出 `PinoLogger`、`PinoDestination`，也不复制日志方法、stream 写入方法或 EventEmitter API；包内只保留
运行时校验和确定性单元测试所需的最小生命周期 seam，它不是 package root API。
`sonic-boom` 由 `pino` 自己声明和解析；本包不直接依赖、不声明 peer，也不 import 或校验其原型品牌。
Pino `10.3.1` 当前声明 `sonic-boom ^4.0.1`，消费应用可以独立使用 SonicBoom `5.x`，npm 会为 Pino 保留其
受支持的 `4.x` 实现，不需要 override。运行时边界是 Pino destination 的生命周期结构：
`newPinoServer` 同步构造时捕获第一次观察到的 `logger.flush` 与 destination `end`/`destroy`，之后只接受相同
函数引用。构造前已经存在的结构化包装会成为基线；本包不再承诺 implementation package provenance 或精确
SonicBoom 版本。
由于 Pino、其 destination 实现与 ThreadStream 的公开声明引用 Node 类型，该包把固定版本的 `@types/node` 声明为正式
依赖，保证仅安装真实发布 tarball 的 TypeScript 消费者也能解析完整声明闭包。当前使用最新 `26.1.1`。
ThreadStream `4.2.0` 仍引用该版本删除的旧别名 `TransferListItem`；它在 Node 25 声明中精确等价于仍存在的
`Transferable`。本包随声明输出一个仅包含 `TransferListItem = Transferable` 的兼容 module augmentation，
不改变运行时代码或 Pino API；对应的[上游问题](https://github.com/pinojs/thread-stream/issues/228)修复发布后
删除该临时声明桥。

## 生命周期

- `newPinoServer` 同步构造时先验证 Pino file destination 或 ThreadStream 的状态结构、logger stream 绑定，
  并冻结第一次稳定读取到的 `flush`/`end`/`destroy`。`start(ctx)` 检查调用方 Context，并在安装原生
  `error`/`close` 监听器前后以及发布 owner 前三次对照这份构造期快照，同时复核 logger stream 绑定、已观察
  failure 与终态，随后才完成所有权移交。准入读取 Pino file destination 的内部 `_ending` 与公开
  `destroyed`/`writable`，以及
  ThreadStream `4.2.0` 的 `destroyed`/`closed`/`writable`/`writableEnded`/`writableFinished`/
  `writableErrored`。Pino file destination 当前没有公开等价的 end-in-progress 状态；本包因此要求 `_ending`
  保持布尔形状，但不据此声称实现版本或 provenance。相对构造快照的方法漂移、logger binding 或状态形状不符
  都会 fail closed；不读取 `ready` 或 `fd`。已关闭或正在
  结束的资源会在所有权移交前被拒绝，
  adapter 不调用其 `end()`/`destroy()`，也会撤销已安装的监听器；`writableErrored` 中的原生 `Error` 保持
  原对象身份。operation getter 在 start revalidation 期间同步触发的 `error`、`close` 或 destination terminal 同样会在
  ownership 发布前被第三次 admission 拒绝，不会进入运行期或触发 owner 调用。`start(ctx)` 返回的 Promise
  表示完整运行期，只在真实原生 `close` 后结算。
- `stop(ctx)` 第一次调用创建共享 owner drain：`logger.flush(callback)`、`destination.end()`、等待原生
  `close`。这些调用使用构造期捕获、start 准入确认的固定函数与原生 receiver；flush 前还会核对 logger 仍绑定
  transferred destination。每个调用方 Context 只限制自己的等待。
- destination 在运行期间意外 `error` 或 `close` 会使 `start(ctx)` 的运行期 Promise reject，并触发清理。
- `destination.end()` 抛错只记录为清理失败，不会提前伪造终态。adapter 默认拥有 25 秒 owner wait 边界，
  并在原生操作返回后复核单调时钟；边界到期会结算共享 stop waiter。Pino file destination 暴露 `destroy()` 时只
  尽力调用一次；ThreadStream 没有公开 force 方法，因此超时错误的 `forceSupported` 为 `false`。无论
  `destroy()` 缺失、抛错还是调用后没有关闭，运行期 Promise 与 listener 都继续等待真实原生 `close`。
  `pinoDrainTimeout(ms)` 只配置这一真实 Pino drain 边界；App 的整体停止等待由 Core `stopTimeout(ms)` 配置。
- adapter 不打开路径。路径错误由应用调用 Pino 官方 constructor 时原样产生，不会被 LikeGo 改写。

Pino 版本固定为当前验证的 `10.3.1`。真实 smoke 会创建官方异步 destination，写入结构化日志，并在
Server stop 后读取最终文件，证明 flush/end/close 的实际顺序。

## 验证

```sh
bun run --cwd packages/pino typecheck
bun run --cwd packages/pino test:coverage
bun run --cwd packages/pino build
bun run --cwd packages/pino test:install
bun run --cwd packages/pino smoke:bun
bun run --cwd packages/pino smoke:node
```

`test:install` 会重新构建并打包完整依赖闭包，在不创建或继承 lockfile 的临时 npm 消费方中安装真实 tarball
与显式 `sonic-boom@5.0.0`，再用原生 Node 运行完整 destination/transport 生命周期；门禁同时确认消费方的
SonicBoom `5.x` 与 Pino 自己解析的受支持 `4.x` 共存，且 `@likego/pino` 没有隐藏的 direct/peer coupling。
