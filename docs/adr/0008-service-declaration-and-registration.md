# ADR 0008：内部服务声明、分派与自动注册

日期：2026-07-21

状态：已被替代

> 本 ADR 记录早期 `ServiceDeclaration`、Fetch transport 与自动注册组合器方案，不再是当前公共契约。
> 当前 Server、Transport 与 App/Registry 分工见
> [`../developer-experience-alignment.md`](../developer-experience-alignment.md)。

## 背景

go-micro 把 Server、Client、Transport、Registry 和 Selector 组合成完整内部调用链；go-kratos 则允许任意
结构式 Server 进入 App。go-like 需要同时保留两点：用户可以自行实现 Server，官方内部调用也必须有一条
声明、分派、注册、发现、选择和调用一致的路径。

如果 handler route 与 Registry endpoint 分别维护，二者会产生漂移。如果注册早于 listener bind，注册表会
发布不可调用地址；如果停止时先关闭 listener，仍在注册表中的实例会把新流量引向正在排空的节点。

## 决策

### Server 保持结构式

Core 继续只要求：

```ts
interface Server<H extends ServerHandle = ServerHandle> {
  start(ctx: Context): Promise<H>
}

interface ServerHandle {
  done(): Promise<void>
  stop(ctx: Context): Promise<void>
}
```

用户自建 HTTP 框架、Cron、consumer、control loop 或其他服务，只要满足该接口，就能与官方适配器一同交给
`newApp(...)`。`@go-like/server` 不引入基类、decorator、反射容器或强制 DI。

### 单一服务声明

`ServiceDeclaration` 是内部服务的唯一事实源：service name/version/metadata、node identity 和 endpoint
name/schema/metadata/handler 在一次不可变声明中提供。go-like 在任何 factory 或 provider I/O 前验证并快照
完整声明。

- `unaryHandler(...)` 将声明投影成 `@go-like/transport` 的 `AcceptHandler`。
- `fetchHandler(...)` 将声明投影成标准 `Request -> Response` transport handler，并保持成功 response body
  streaming，不预读或重新包装。
- 同一 endpoint 集合投影成精确 Registry `Endpoint[]`；runtime handler 不进入 Registry wire。
- service/endpoint 值大小写敏感；header 名按协议大小写不敏感；未知路由 fail closed。
- handler 抛出的已标记 `ServiceError` 使用 canonical wire envelope；未知错误只暴露固定 internal error。

### 中间件

`composeUnary(handler, ...middleware)` 与 `composeFetch(handler, ...middleware)` 都只组合普通函数，
并复用 `@go-like/transport` 的 Context-first middleware 契约。第一个声明的 middleware 是最外层。
它们不依赖 class、decorator 或全局 registry，也不跨越外部 Web framework 的 middleware 所有权。

Fetch middleware 直接围绕标准 `Request -> Response` handler 组合；成功 response body 仍保持 streaming，
不会因为组合而被预读或重新包装。full-duplex RPC stream 仍是独立待设计能力，不能把单次
Fetch streaming 冒充双向 Stream。

### 绑定、注册与停止顺序

`registeredUnaryService(...)` 与 `registeredFetchService(...)` 使用 Core 既有生命周期组合，固定顺序：

```text
transport server start/bind
advertise address resolve
startup readiness gate (when configured)
runtime register check initial evaluation (when configured)
registry registration start when ready

registry registration stop
transport server drain/stop
```

默认 advertise address 只在 admission 后读取 `AddressServer.address()`。容器、NAT、Ingress 或 unspecified bind
必须使用显式 resolver；go-like 不猜 scheme、host 映射或可达性。空地址、重复地址或非法 resolver 结果在任何
Registry 写入前 fail closed，并回滚已经绑定的 Server。

Core 的逆序 stop 保证撤注册先于 listener drain。注册失败会回滚 listener；撤注册失败不会跳过 listener
drain，多个独立失败按观察顺序聚合。

`readiness(gate)` 是只执行一次的启动门禁：transport 绑定并解析 advertise address 后检查，只有严格
返回 `true` 才会开始 Registry 写入。`false`、非 `true` 结果或异常都会使启动失败，并逆序排空已绑定的
transport；它不在运行期重新检查。

`registerCheck(check, intervalMs)` 则持有运行期轮询。初次 `false` 仍允许 App 以 transport 已绑定、服务未
发布的状态完成启动；之后的串行检查会在 `true -> false` 时停止当前唯一注册 token，在
`false -> true` 时创建一个新 token，稳定状态不重复注册。普通 `false` 不是运行错误；检查、注册、
撤注册失败，或当前 token 意外终止，都会进入 Server `done()` 的异常终态，触发 Core fail-fast 并继续
逆序排空 transport；独立的排空失败按稳定顺序聚合。

### Client 组合

配置 Discovery 的 `newClient` 按服务名懒持有 watcher/cache，每次 unary attempt 从最新快照执行
selection、dial/send/recv、feedback 和逻辑 client close；直连调用不创建 watcher。Client 不做隐式 retry 或
私有 timeout，应用结束使用时调用 `client.close(ctx)`。调用成功后，feedback/close failure 不覆盖成功响应；
主调用和后置清理都失败时按稳定顺序聚合。go-like 不再提供第二套 `newResidentClient` 或逻辑连接池。

`@go-like/transport-http` 同时实现内部 unary client/server 和标准 Fetch transport server。`@go-like/web`
仍只负责外部 Web 请求；两层不互相重导出。需要外部 Web 到内部 Client 的 gateway 时，必须由显式 route
table 桥接。

## 验证要求

- 单元/类型测试锁定声明验证、不可变投影、header 路由、middleware 顺序、ServiceError、feedback 和 cleanup。
- provider-neutral conformance 验证 Transport 与 Registry 边界。
- 真实联合 E2E 必须完成 `bind -> register -> discover -> select -> call`，并验证 registration failure 回滚、
  stop 后 Registry 为空、端口可重绑定和全部资源归零。
- Fetch streaming 必须在真实 Node HTTP listener 中验证背压、取消与 graceful drain；不得称为 full-duplex RPC。

## 后果

go-like 同时获得 go-micro 风格的完整内部调用链和 go-kratos 风格的自由 Server 组合。声明漂移、注册时序和
地址猜测被收敛到清楚边界，而外部 Web、内部 Transport、Registry provider 与应用路由仍可独立替换。
