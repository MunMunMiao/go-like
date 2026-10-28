# 服务契约与开发者体验调研

研究日期：2026-09-27。保留当时对 go-kratos v3 与 go-micro v6 的源码调查、对比和取舍，不把旧版行为描述为当前上游状态。

## 研究问题与设计演变

问题是如何让 TypeScript 契约同时提供类型、路由身份和操作名，并把契约、服务实现、服务端注册与客户端构造分开。
早期工作稿使用 `service(...)`、`endpoint(...)` 和 `registerService(...)`；后续方案改用 `defineService(...)` 派生注册函数与 typed client，详见[内部 RPC 设计](../designs/internal-rpc-design.md)。早期草案的签名不再单独作为使用指南保留。

研究采用 Kratos 的契约优先与分层思路，同时借鉴 go-micro 的能力域和 provider 组织。TypeScript 的值契约不需要为了复用这些思路而引入 Protobuf 生成。

## 调研方法与抽查

- 调研对象：go-kratos v3.0.0（2026-06-26 发布）、go-micro v6.14.0（2026-09-21 发布），版本状态以原调查日期为准。
- 研究输入包括官方文档、项目模板、官方示例、多服务示例、代码生成器、核心源码与 issue；下文保留对应出处。
- 原调查记录的本地源码抽查项：
  - kratos：`v3.0.0` tag；`Transporter.Operation()`；`selector` 的 `Server/Client/Prefix/Regex/Path/Match`；HTTP 和 gRPC server 都有 `Use(selector, m...)`；`internal/endpoint.ParseEndpoint` 按 scheme 挑地址；`Router.Handle` 不自动套中间件；beer-shop 用 `discovery:///beer.user.service` 等端点；v2 文档中 `errors.default_code` / `errors.code` 的写法；casbin 示例白名单手写 `"/admin.v1.AdminService/Login"`。
  - go-micro：模块路径 `go-micro.dev/v6`；`NewService(name string, opts ...Option)`；`service.Handle`；反射命名 `name + "." + e.Name`；`EndpointOptions map[string][]CallOption` 与 `ResolveCallOptions`；生成的 `NewGreeterService(name, c)`、`NewRequest(c.name, "Greeter.Hello", in)`、局部类型 `Greeter`；`registry.Service/Endpoint/Value` 结构；go-micro/demo 的 `pb.NewCartService(cfg.CartService, client)`；`WrapClient/WrapCall/WrapHandler/WrapSubscriber`；client 把 ctx metadata 和 `Timeout` 写入请求头；router 对不合格方法只打日志就 `return nil`；issue #2782「Remove reflect」于 2026-02-03 关闭。
- 其余细节保留原调查引用，未作为本次整理中重新核实的事实。

---

## 调研：go-kratos v3

### 1 版本基线

| 来源                    | 版本                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------- |
| go-kratos/kratos        | `v3.0.0`（main `668db92`）                                                              |
| go-kratos/kratos-layout | main `59ad406`（依赖 `kratos/v3 v3.0.0`，Go 1.25.7）                                    |
| go-kratos.dev           | main `8e0db39`；v3 文档由 PR #264（2026-09-21）重写；v2 版文档取历史提交 `e0e143a` 对照 |
| go-kratos/examples      | `61daed1`，仍用 `kratos/v2 v2.8.0`                                                      |
| go-kratos/beer-shop     | `f762a42`，仍用 `kratos/v2 v2.2.0`                                                      |

v3 变化的一手出处：[迁移指南 v2-to-v3.md](https://github.com/go-kratos/kratos/blob/v3.0.0/docs/migration/v2-to-v3.md?plain=1)、[#3820](https://github.com/go-kratos/kratos/issues/3820)。v2 → v3 主要是依赖清理（slog、json 与 protojson 拆分、JWT/OTel 移到 contrib、删除 binding 包）和 HTTP 流式生成，业务分层与 API 范式基本不变。

### 2 项目结构与分层

- `api/<domain>/<version>/` 是唯一对外契约（proto 源 + 生成物）；`cmd/<app>/` 是入口和 Wire 组合根；`internal/server` 构造 transport、挂中间件、注册服务；`internal/service` 是 transport 适配层，做 DTO↔DO 转换；`internal/biz` 放 DO、usecase、repo 接口和错误；`internal/data` 放 repo 实现、存储客户端和外部客户端；`internal/conf` 是配置 proto。
- 分层理由是 DDD / Clean Architecture 的依赖倒置：biz 声明自己需要的接口，data 在边缘实现。v3 文档强调 layout 只是模板约定，不是框架强制（[设计理念](https://go-kratos.dev/zh-cn/docs/intro/design/)）。
- **调用其他服务的 RPC client 放在 `internal/data`**，藏在 biz 声明的 repo 接口后面（[beer-shop data.go L84–101](https://github.com/go-kratos/beer-shop/blob/f762a42/app/shop/interface/internal/data/data.go#L84-L101)、[user.go L44–53](https://github.com/go-kratos/beer-shop/blob/f762a42/app/shop/interface/internal/data/user.go#L44-L53)）。
- 多服务共享 api：beer-shop 是单个 Go module，顶层 `api/<svc>/<kind>/v1` 供各 `app/*` 直接 import；v2 文档还给了“统一 proto 仓库”的备选。
- 客户端构造：`discovery:///<应用名>` + `WithDiscovery` 得到连接，再交给生成的 `NewXxxClient`；同一个应用名可以同时用 gRPC 和 HTTP 访问（[examples registry/etcd client L25–39](https://github.com/go-kratos/examples/blob/61daed1/registry/etcd/client/main.go#L25-L39)）。
- 分层规则写在 [kratos-layout AGENTS.md L41–46](https://github.com/go-kratos/kratos-layout/blob/59ad406/AGENTS.md?plain=1#L41-L46)：service 只 import api 和 biz；biz 只为错误原因枚举 import api；data import biz 实现 repo 接口；只有 cmd 通过 Wire 装配所有层。
- 版本差异：v3 模板删掉了 `third_party/`，改用 `buf.yaml` 依赖 googleapis；官方没有 v3 版的多服务示例。

### 3 API 定义范式

- 命名：`package <domain>.<version>`（如 `todo.v1`）；service 名 `XxxService`；RPC 用“动词+名词”，集合用复数（`ListTodos`）；请求类型 `XxxRequest`，响应直接返回资源；大量使用 AIP 字段约定（`field_behavior`、`page_token`、`filter`、`order_by`、`FieldMask`）。
- 生成物：`*.pb.go`；`*_grpc.pb.go`（`RegisterXServer`、`NewXClient`、`X_Method_FullMethodName`）；`*_http.pb.go`（`OperationXxx` 常量、`XHTTPServer` 接口、`RegisterXHTTPServer`、`NewXHTTPClient`）；`openapi.yaml`。
- `google.api.http` 映射：路径变量交给 `BindVars`；`body:"field"` 绑定字段，`body:"*"` 绑定整个消息；其余走 `BindQuery`；每个 `additional_bindings` 生成一条路由；没有注解的方法默认不生成 HTTP 路由。一份声明同时驱动服务端绑定和客户端 `BuildPath`（[todo_http.pb.go L62–71](https://github.com/go-kratos/kratos-layout/blob/59ad406/api/todo/v1/todo_http.pb.go#L62-L71)、[L376–385](https://github.com/go-kratos/kratos-layout/blob/59ad406/api/todo/v1/todo_http.pb.go#L376-L385)）。
- 生成的 HTTP handler 会用 `http.SetOperation(ctx, OperationTodoServiceGetTodo)` 把操作名设为规范名，再走 `ctx.Middleware(...)`：

```go
const OperationTodoServiceGetTodo = "/todo.v1.TodoService/GetTodo"

func RegisterTodoServiceHTTPServer(s *http.Server, srv TodoServiceHTTPServer) {
	r := s.Route("/")
	r.Handle("GET", "/v1/todos/{id}", _TodoService_GetTodo0_HTTP_Handler(srv))
}
```

- `protoc-gen-go-errors`：读取 enum 上的 `(errors.default_code)` 和 `(errors.code)`，生成 `IsXxx` / `ErrorXxx`（[errorsTemplate.tpl](https://github.com/go-kratos/kratos/blob/v3.0.0/cmd/protoc-gen-go-errors/errorsTemplate.tpl#L4-L15)、[v2 errors.md](https://github.com/go-kratos/go-kratos.dev/blob/e0e143a/src/content/docs/zh-cn/docs/component/errors.md?plain=1#L57-L70)）。v3 模板没有启用它（[v3 错误文档](https://go-kratos.dev/zh-cn/docs/component/errors/)）。
- 校验：v2 用 PGV 生成的 `Validate()`；v3 用可插拔的 `validate.Validator(fns...)`，模板接 AIP `fieldbehavior`，而且只装在 HTTP server 上（[http.go L18–28](https://github.com/go-kratos/kratos-layout/blob/59ad406/internal/server/http.go#L18-L28)、[grpc.go L14–18](https://github.com/go-kratos/kratos-layout/blob/59ad406/internal/server/grpc.go#L14-L18)）。
- 版本差异：v3 生成 `r.Handle(method, …)` + `http.BuildPath`，默认 `application/protojson`；新增 HTTP 流式映射（服务端流 → SSE，客户端流/双向流 → WebSocket）。

### 4 服务实现范式

- 一个嵌入 `v1.UnimplementedTodoServiceServer`、持有 `*biz.TodoUsecase` 的 struct，方法签名 `(ctx, *Req) (*Reply, error)`（[service/todo.go L26–57](https://github.com/go-kratos/kratos-layout/blob/59ad406/internal/service/todo.go#L26-L57)）。
- 一份实现同时满足 gRPC 和 HTTP 两个生成接口，在 server 层分别注册。
- service 层只做边界工作：校验 ID、DTO→DO、DO→DTO；不写业务规则，不碰存储。
- Wire：每层导出 `ProviderSet`；data 的构造函数返回 biz 接口；`NewData` 同时返回 cleanup（[wire.go L22–24](https://github.com/go-kratos/kratos-layout/blob/59ad406/cmd/server/wire.go#L22-L24)）。
- 测试放在被测包旁边：service 测试用“真实 usecase + 内存 fake repo”，用 `errors.IsNotFound` 断言错误语义（[todo_test.go](https://github.com/go-kratos/kratos-layout/blob/59ad406/internal/service/todo_test.go#L18-L21)）。

### 5 Server / Client 与 transport 抽象

- `http.NewServer` / `grpc.NewServer` 都用函数式 options，都实现 `transport.Server{Start, Stop}` 和 `transport.Endpointer`；gRPC server 默认注册 health、reflection、admin。
- 注册用生成函数：`v1.RegisterTodoServiceServer`、`v1.RegisterTodoServiceHTTPServer`。
- Client：`grpc.NewClient` 返回原生连接，`http.NewClient` 返回 `*http.Client`，再交给生成的 client 构造函数。常用 options：`WithEndpoint`、`WithDiscovery`、`WithMiddleware`、`WithTimeout`（默认 2s）、`WithTLSConfig`、`WithNodeFilter`、`WithSubset`；gRPC 另有 `WithStreamMiddleware`、`WithHealthCheck`；HTTP 另有 `WithBlock`（[grpc/client.go](https://github.com/go-kratos/kratos/blob/v3.0.0/transport/grpc/client.go#L36-L140)、[http/client.go](https://github.com/go-kratos/kratos/blob/v3.0.0/transport/http/client.go#L60-L162)）。
- `Transporter { Kind, Endpoint, Operation, RequestHeader, ReplyHeader }` 放在 context 里，server 端和 client 端用不同的 key（`FromServerContext` / `FromClientContext`），所以“处理请求时再发起下游调用”不会串（[transport.go L37–95](https://github.com/go-kratos/kratos/blob/v3.0.0/transport/transport.go#L37-L95)）。
- 版本差异：v2 的 `grpc.Dial` / `DialInsecure` 在 v3 只剩 `grpc.NewClient`（迁移指南没提）；v3 不再默认注册 `kratos.api.Metadata` 服务（[PR #3825](https://github.com/go-kratos/kratos/pull/3825)）。

### 6 Operation 命名与按操作挂中间件

- Operation 统一为 `/<package>.<Service>/<Method>`；生成代码同时导出 `OperationTodoServiceGetTodo`（HTTP）和 `TodoService_GetTodo_FullMethodName`（gRPC），两者值相同。
- gRPC 服务端直接用 `info.FullMethod`；HTTP 服务端先把 Operation 设为路由模板，生成的 handler 再覆盖成规范名（[http/server.go L280–289](https://github.com/go-kratos/kratos/blob/v3.0.0/transport/http/server.go#L280-L289)）。
- 两种按操作挂中间件的方式：
  - server 的 `Use(selector, ms...)`：`/*`、`/pkg.Service/*` 或完整名，按最长前缀匹配；
  - `selector.Server(ms...)` / `selector.Client(ms...)` 构建器：`Path`（精确）、`Prefix`、`Regex`（整串匹配）、`Match(func(ctx, operation) bool)`，`.Build()` 后是普通 middleware（[selector.go](https://github.com/go-kratos/kratos/blob/v3.0.0/middleware/selector/selector.go#L42-L106)）。
- 官方强调匹配的是 Operation，不是 HTTP 路径（[v2 文档](https://github.com/go-kratos/go-kratos.dev/blob/e0e143a/src/content/docs/zh-cn/docs/component/middleware/overview.md?plain=1#L198-L200)）。
- 典型用法是鉴权白名单；但官方 casbin 示例的白名单里是手写字符串，没有用生成的常量（[casbin http.go L25–37](https://github.com/go-kratos/examples/blob/61daed1/casbin/app/admin/internal/server/http.go#L25-L37)）。

### 7 错误模型

- `*errors.Error` = `Status{Code, Reason, Message, Metadata}` + 内部 `cause`。`Code` 用 HTTP 语义；`GRPCStatus()` 把它映射成 gRPC code，并把 reason 和 metadata 放进 `google.rpc.ErrorInfo`，两种协议都能还原（[errors.go L58–68](https://github.com/go-kratos/kratos/blob/v3.0.0/errors/errors.go#L58-L68)）。
- `errors.Is` 比较 code + reason；`FromError` 依次尝试 `errors.As`、从 gRPC status 还原、最后兜底 500；HTTP 服务端用 `Code` 作为状态码，HTTP 客户端把非 2xx 解回 `*errors.Error`。
- 推荐写法：proto 定义 `ErrorReason` 枚举；biz 声明包级错误变量 `errors.NotFound(v1.ErrorReason_TODO_NOT_FOUND.String(), "todo not found")`；data 把驱动错误映射成这些 biz 错误（[biz/todo.go](https://github.com/go-kratos/kratos-layout/blob/59ad406/internal/biz/todo.go#L16-L21)）。
- 设计理念：reason 是稳定可分支的标识，调用方不要判断 message；message 必须可以安全公开；metadata 不得包含 secret。
- HTTP/gRPC 状态映射是多对一的（例如 409 同时对应 Aborted 和 AlreadyExists）（[status.go](https://github.com/go-kratos/kratos/blob/v3.0.0/transport/http/status/status.go)）。

### 8 元信息传递

- `metadata.Metadata` 是 `map[string][]string`（key 小写），挂在 context 上；server 和 client 两端都装中间件才会跨网络。
- server 端默认只收 `x-md-` 前缀；client 端发出常量、显式设置的 client metadata，以及 server metadata 里 `x-md-global-` 前缀的值。`x-md-global-*` 逐跳透传，`x-md-local-*` 只在本服务可见；官方建议用 allowlist，追踪走 OTel（[metadata.go](https://github.com/go-kratos/kratos/blob/v3.0.0/middleware/metadata/metadata.go#L44-L110)、[元数据文档](https://go-kratos.dev/zh-cn/docs/component/metadata/)）。

### 9 App 与注册中心

- `kratos.New` 的 options：`ID`、`Name`、`Version`、`Metadata`、`Endpoint`、`Context`、`Logger`、`Server`、`Signal`、`Registrar`、`RegistrarTimeout`（默认 10s）、`StopTimeout`，以及 `BeforeStart`、`AfterStart`、`BeforeStop`、`AfterStop` 四个 hook。
- 生命周期：`Run` = 构造实例 → BeforeStart → 并发启动 server → 注册 → AfterStart → 等信号；`Stop` = BeforeStop → 注销 → 取消 context → 在 StopTimeout 内停止 server → AfterStop。
- `ServiceInstance.Endpoints` 是 URL 字符串列表（`grpc://ip:port`、`http://ip:port`），未显式指定时从实现了 `Endpointer` 的 server 自动收集（[app.go L176–199](https://github.com/go-kratos/kratos/blob/v3.0.0/app.go#L176-L199)、[registry.go L37–51](https://github.com/go-kratos/kratos/blob/v3.0.0/registry/registry.go#L37-L51)）。
- `discovery:///<Name>` 的 path 就是注册时的应用名；resolver 按本 transport 的 scheme 从实例 Endpoints 里挑地址，所以一个应用名下 HTTP 和 gRPC 可以共存（[internal/endpoint/endpoint.go](https://github.com/go-kratos/kratos/blob/v3.0.0/internal/endpoint/endpoint.go#L13-L24)）。
- 操作名用 proto 包名（`/user.service.v1.User/GetUser`），发现用应用名（`beer.user.service`），两个命名空间彼此独立。
- `kratos.FromContext(ctx)` 取 AppInfo。

### 10 不用 proto 时

- 可以用 `srv.Route(prefix)` 得到 Router（`GET/POST/…/Group`，handler 签名 `func(http.Context) error`），或用 `Handle/HandleFunc/HandlePrefix` 挂原生 handler。
- **手写路由不会自动执行 `http.Middleware` 注册的中间件链**，只经过 Filter；要复用中间件，必须手动 `http.SetOperation` + `ctx.Middleware(h)`，否则 Operation 只是路径模板（[router.go L45–59](https://github.com/go-kratos/kratos/blob/v3.0.0/transport/http/router.go#L45-L59)、[示例 handlers.go](https://github.com/go-kratos/examples/blob/61daed1/http/middlewares/handlers.go#L10-L26)、[#3670](https://github.com/go-kratos/kratos/issues/3670)）。
- 官方定位：proto 是服务契约，手写路由是文件上传、回调等场景的“逃生门”；没有官方的无 proto 类型化契约机制，v3 核心唯一的泛型 API 是 `config.Get[T]`。

### 11 设计理念与分层

- 工具箱 / “插座”：core 提供标准连接点，应用在边缘接入自己的实现。
- API 设计参考 Google API 指南与 AIP；要求版本化 package、保留字段号；HTTP path 也是公开 API；不兼容时新建 `v2` package（[v3 Protobuf 规范](https://go-kratos.dev/zh-cn/docs/guide/api-protobuf/)）。
- 中间件一种形态同时用于 HTTP 和 gRPC；核心不提供重试，重试与幂等由应用决定。
- 日志统一 `slog`，OTel 集成移到 contrib。
- kratos-layout 区分 DTO/DO/PO，约束各层依赖方向，并按 Repository、Usecase、Service 分配职责。

### 12 值得借鉴的范式

1. 契约包只放契约和生成的适配器，transport、发现、TLS、中间件、超时都在包外配置。
2. 每个方法有规范全名 `/<pkg>.<Service>/<Method>` 并以常量导出，中间件选择、日志、指标、追踪、白名单用同一个名字。
3. 一份实现注册到多个 transport，签名统一为 `(ctx, req) → reply`。
4. 发现名（应用名）与契约名分开；实例注册多条带 scheme 的 URL，客户端按自身 transport 挑选。
5. Transporter 放进 context，server 与 client 用不同的 key。
6. 中间件统一为 `(next) => handler`，server 与 client 共用。
7. 按 Operation 选择中间件（Path/Prefix/Regex/Match 构建器 + `Use(pattern)`），与 HTTP 路由形态无关。
8. 一份声明式 HTTP 映射同时驱动服务端绑定和客户端 BuildPath。
9. 四字段错误模型（HTTP 语义的 code、稳定可分支的 reason、安全的 message、结构化 metadata），reason 枚举生成辅助函数。
10. 校验做成可插拔的中间件链。
11. 用 `x-md-global-` / `x-md-local-` 前缀表达传播语义，配合 allowlist。
12. App 生命周期“先启动再注册、先注销再停机”，停机有超时，有四个 hook，endpoint 自动收集。
13. 依赖倒置，把远程服务的 client 放到 data 层接口之后。
14. 生成物与手写实现边界清晰，分层规则显式可查。

### 13 代价与被诟病之处

1. 手写路由是二等公民：不自动执行中间件，Operation 退化成路径模板，白名单只能手写字符串（[#3670](https://github.com/go-kratos/kratos/issues/3670)）。
2. 错误模型与“统一响应包装、200 + 业务码”的需求冲突，又会碰上 protojson 零值省略（[#1281](https://github.com/go-kratos/kratos/issues/1281)、[#1952](https://github.com/go-kratos/kratos/issues/1952)、[#1539](https://github.com/go-kratos/kratos/issues/1539)）。
3. 状态映射多对一，gRPC 原生 code 不能完整往返。
4. proto 工具链 + 分层样板偏重（buf 插件、生成物入库、每层 ProviderSet 和 Wire、DTO/DO/PO 三次转换）。
5. 中间件按 server 分别配置，两端容易不一致（模板的 validate 只装在 HTTP 上）。
6. v3 生态和文档仍在追赶：examples 与 beer-shop 停在 v2；contrib 子模块缺 tag（[#3846](https://github.com/go-kratos/kratos/issues/3846)）；若干文档漂移。
7. 不安全默认值：未匹配路由回落到 `http.DefaultServeMux`（[#3810](https://github.com/go-kratos/kratos/issues/3810)，NOT_PLANNED）；继续使用已归档的 gorilla/mux（[#2912](https://github.com/go-kratos/kratos/issues/2912)）。

---

## 调研：go-micro v6

出处约定：不带前缀的路径相对于 [`micro/go-micro@9e5c1dd`](https://github.com/micro/go-micro/tree/9e5c1dde6bf243027c1cec352612bf72eaf35048)（2026-09-26 的 master），`#L` 后是行号；`@v4.11.1:` 这类前缀表示对应 tag；其他仓库写成 `go-micro/demo:路径`。

### 1 现状与版本

- 最新 **v6.14.0**（2026-09-21），模块路径 `go-micro.dev/v6`，仓库 `micro/go-micro`（`asim/go-micro` 重定向至此），Apache-2.0，Go 1.25。文档站 https://go-micro.dev 在线；示例在主仓库 `examples/`；`micro/examples`、`micro/micro` 两个仓库已 404。
- 模块路径历史：v1 `github.com/micro/go-micro`（2019-03）→ v2 `…/v2`（2020-01）→ v3 `github.com/asim/go-micro/v3`（2021-01）→ v4 `go-micro.dev/v4`（2021-10）→ v5 `go-micro.dev/v5`（2024-06）→ v6 `go-micro.dev/v6`（2026-06）；v4.11.1 维护版发布于 2026-09-10。
- v6 的重心转向 `NewAgent`、`NewFlow` 和 MCP/A2A 网关；服务侧新增 `NewGroup`（多服务同进程）、`client.Local()`（v6.8）、`EndpointOptions` / `DiscoveryError` / `WaitForService`（v6.14）。
- `micro.NewService(name, opts...)` 是服务构造函数，旧的无名写法已删除（`CHANGELOG.md#L381-383`）。
- proto 可选：2026-06-22 起 `micro new` 默认不生成 proto，需要时加 `--proto`（PR #2986）。
- 维护风险：2024-07 作者公开寻找新 owner（[#2723](https://github.com/micro/go-micro/issues/2723)）；2026 年起由自动化 “loop” 合并代码并发版（`CHANGELOG.md#L8`）；2026-09 开了许可与商业模式 RFC（[#4912](https://github.com/micro/go-micro/issues/4912)）。2020 年 v3 曾改名 Nitro 并换成非商业许可（[#2077](https://github.com/micro/go-micro/issues/2077)、[#2086](https://github.com/micro/go-micro/issues/2086)）。

### 2 服务定义与 handler 注册

- 一个服务就是注册中心里的一个名字；handler 可以是任意导出的 struct，每个签名合格的方法就是一个 endpoint，名字为「类型名.方法名」，靠反射取得（`server/rpc_handler.go#L27,51`）。
- 合格签名只有 `func(ctx, *Req, *Rsp) error` 和流式的 `func(ctx, server.Stream) error`；**不合格的方法只打一条日志就被跳过**，只有整个 struct 一个合格方法都没有时才报错（`server/rpc_router.go#L143-186,491`）。
- response 是出参：router 用 `reflect.New` 预分配 response，handler 往里填（`server/rpc_router.go#L396`）；router 明显改自标准库 `net/rpc`，官方没有解释为什么这样设计。
- 不用 protobuf 也可以：client 默认 `application/json`（`client/rpc_codec.go#L55`），普通 struct 加 json tag 即可。
- 注册时发布 `registry.Endpoint{Name, Request, Response, Metadata}`：Request/Response 是反射得到的字段树（字段名取 json tag，最多递归 3 层）；Metadata 来自 `EndpointMetadata`、`WithEndpointScopes`（`server/doc.go#L94`），以及 v6 从 doc 注释和 `@example` 解析出的内容（`server/comments.go`）。

```go
type Say struct{}
// Hello greets a person by name.
// @example {"name": "Alice"}
func (h *Say) Hello(ctx context.Context, req *Request, rsp *Response) error {
	rsp.Message = "Hello " + req.Name
	return nil
}
service := micro.NewService("greeter")
service.Init()
if err := service.Handle(new(Say)); err != nil { log.Fatal(err) }
```

（`README.md#L238-263`）

### 3 Client 范式

- 两步：`NewRequest(service, endpoint, req)`，然后 `Call(ctx, req, &rsp, opts...)`。`service` 只用于服务发现和选节点；`endpoint` 通过 `Micro-Endpoint` 请求头传给对端 router 分派，server 端不检查 `Micro-Service`（`server/rpc_router.go#L424-442`）。
- 生成代码把两个字符串都藏起来：`NewGreeterService(name, c)` 在构造时传入服务名，endpoint 字符串写死在生成代码里。
- 真实项目（`go-micro/demo:service/checkout/main.go#L71-80`）在 main 里用配置中的服务名构造 6 个下游 client，作为 struct 字段注入 handler：

```go
checkoutService := &handler.CheckoutService{
	CartService:     pb.NewCartService(cfg.CartService, client),
	CurrencyService: pb.NewCurrencyService(cfg.CurrencyService, client),
	// ...
}
```

- 调用选项三层合并：client 默认值 → `EndpointOptions["service/Endpoint"]` → 单次 `CallOption`；截止时间取调用方 ctx 和请求时限中较早的一个（`client/options.go#L40,468-480`、`client/rpc_client.go#L443`）。
- 默认值：整次请求 30s、单次尝试 5s、`DefaultRetries = 5`，但默认 `RetryOnError` 只重试 408，且注释说会重试 500、实现并不重试（`client/options.go#L19-25`、`client/retry.go#L17-32`）。
- 设置 `MICRO_PROXY` 后所有调用转发给代理，原服务名仍在请求头里（`internal/util/net/net.go#L86-98`）。

### 4 protoc-gen-micro 生成代码

- 生成 `*.pb.micro.go`：client 侧 `XService` 接口 + `NewXService(name, c)`；server 侧 `XHandler` 接口（response 仍是出参）+ `RegisterXHandler`。
- `RegisterXHandler` 在函数内部定义一个和 proto 服务同名的局部类型包住用户实现，这样反射取到的前缀永远是 proto 服务名，实现类改名不影响线上名字：

```go
func NewGreeterService(name string, c client.Client) GreeterService {
	return &greeterService{c: c, name: name}
}
func (c *greeterService) Hello(ctx context.Context, in *Request, opts ...client.CallOption) (*Response, error) {
	req := c.c.NewRequest(c.name, "Greeter.Hello", in)
	out := new(Response)
	err := c.c.Call(ctx, req, out, opts...)
	// ...
}
func RegisterGreeterHandler(s server.Server, hdlr GreeterHandler, opts ...server.HandlerOption) error {
	type Greeter struct{ greeter }
	h := &greeterHandler{hdlr}
	return s.Handle(s.NewHandler(&Greeter{h}, opts...))
}
```

（`cmd/protoc-gen-micro/examples/greeter/greeter.pb.micro.go#L40-54,120-130`）

- 服务名必须显式传入；生成器里“默认用 proto package 名当服务名”的代码被注释掉了（`cmd/protoc-gen-micro/plugin/micro/micro.go#L162-170`）。
- v4 生成器还会读 `google.api.http` 生成 `NewXEndpoints()`，注册时用 `api.WithEndpoint` 把 HTTP 路由写进 endpoint 元数据；`api` 包在 v5.1.0（2024-07）删除，这部分随之消失。

### 5 注册中心与选择器

- Registry 接口：`Register`、`Deregister`、`GetService`、`ListServices`、`Watch`；默认 mDNS。
- 结构：`Service{Name, Version, Metadata, Endpoints, Nodes}`、`Endpoint{Request, Response *Value, Metadata, Name}`、`Value{Name, Type, Values}`（`registry/registry.go#L31-57`）。
- server 启动时注册，每 30s 续约，TTL 90s；`Node.Metadata` 自动写入 transport、broker、server、registry、`protocol=mucp`（`server/rpc_server.go#L416-429,683`、`server/server.go#L147-148`）。
- selector：从带缓存的注册中心取服务 → 依次过滤（`FilterEndpoint`、`FilterVersion`、`FilterLabel`）→ 策略（默认 `Random`，可换 `RoundRobin`）→ 返回 `Next()`；过滤器要调用方通过 `WithSelectOption` 传入；默认 selector 的 `Mark` / `Reset` 是空函数（`selector/default.go#L64-87,106`）。
- v6 里注册中心同时是 MCP、A2A 和 agent 工具发现的唯一数据来源，`registry.Endpoint` 被转成工具 schema（`model/tools.go#L101-128`）。

### 6 中间件（wrapper）

- `server.HandlerWrapper`（`func(HandlerFunc) HandlerFunc`）、`server.SubscriberWrapper`、`client.Wrapper`（`func(Client) Client`，通常内嵌后只覆盖 `Call`）、`client.CallWrapper`（包住对某个节点的单次尝试，处在重试循环里层）。
- 通过 `micro.WrapHandler/WrapSubscriber/WrapClient/WrapCall` 注入（`service/options.go#L283-314`），先注册的在最外层。
- `server.Request` 提供 `Service()`、`Method()`、`Endpoint()`、`Header()`、`Body()`（已解码）。
- 按 endpoint 区别对待靠在 wrapper 里比较 `req.Endpoint()`，例如 auth wrapper 的 `SkipEndpoints: []string{"Health.Check"}`（`wrapper/auth/server.go#L41-48`）；OTel wrapper 的 span 名是 `service.endpoint`（`wrapper/trace/opentelemetry/wrapper.go#L114-131`）。

### 7 错误模型

- `errors.Error{Id, Code, Detail, Status}`，v6.14 加 `Reason`、`Domain`；`Code` 用 HTTP 状态码，`Status` 由 `http.StatusText` 自动填；`Id` 一般写服务名或 endpoint 名。
- 构造函数 `BadRequest`、`NotFound`、`Timeout`、`InternalServerError` 等；v6.14 新增 `AlreadyExists`、`FailedPrecondition`、`ResourceExhausted`、`Unavailable`。
- 线上格式是 `json.Marshal` 后的字符串，mucp 协议下放在 `Micro-Error` 请求头；client 拿到字符串类型的 `serverError`，要用 `errors.FromError` 还原；handler 返回普通 `fmt.Errorf` 会丢状态码（`errors/errors.go#L14-38,186`、`client/rpc_codec.go#L26`）。
- `Is` 主要比较 Code，Reason/Domain 可选。

### 8 元信息

- `metadata.Metadata` 是 ctx 里的 `map[string]string`；`FromContext` 返回副本。
- server 端复制全部请求头，加上 `Local`/`Remote`；`Timeout` 请求头（纳秒）变成 ctx 截止时间（`server/rpc_server.go#L243-258`）。
- client 端把 ctx 里的 metadata 全部复制到请求头（只跳过 `Micro-Topic`），再写入 `Timeout`（`client/rpc_client.go#L99-123`）。**没有白名单，全部往下传。**

### 9 发布订阅

- 发布：`micro.NewEvent(topic, client).Publish(ctx, msg)`；订阅：`micro.RegisterSubscriber(topic, server, h, opts...)`，`h` 可以是函数或 struct；消息类型由参数类型决定。
- 订阅者也作为 endpoint 发布到注册中心（名字 `Func` 或 `Struct.Method`，元数据带 `topic`、`subscriber=true`）；`SubscriberQueue` 实现竞争消费，`DisableAutoAck` 关闭自动确认（`server/subscriber.go#L58-62,86`）。
- topic 没有命名规范；v6 的 pubsub 模板改为直接调用 `broker.Publish/Subscribe`，事件编排交给 `NewFlow`。

### 10 项目模板与多服务示例

- v6 `micro new foo` 默认生成 `main.go`、`handler/foo.go`、`Makefile`、`README.md`、`.gitignore`、`go.mod`，并挂上 `mcp.WithMCP(":3001")`；加 `--proto` 或用 crud/pubsub/api 模板时生成 `proto/foo.proto`（`cmd/micro/cli/new/new.go#L210-212`）。
- v4 时代 `go-micro new service foo`（独立仓库 go-micro/cli，已归档）生成 `main.go`、`handler/`、`proto/`、`Makefile`、`Dockerfile`；开发流程 `make proto tidy` → `go-micro run` → `go-micro call helloworld Helloworld.Call '{...}'`。
- 跨服务调用的真实示例在 go-micro/demo（Online Boutique 移植版），见 10.3；v6 主仓库示例里没有 handler 调用另一个服务的例子。

### 11 API 网关映射与历史命名空间

- v1–v4 的 `micro api` 默认命名空间 `go.micro.api`：`/greeter/say/hello` → 服务 `go.micro.api.greeter` 的 `Say.Hello`；`/foo/bar` → `Foo.Bar`（`@v1.18.0:api/resolver/micro/route.go#L14-15`）。
- 当年的命名习惯：后端 `go.micro.srv.X`、HTTP 聚合层 `go.micro.api.X`、web `go.micro.web.X`；网关 handler 类型 `api`、`rpc`、`http`、`web`、`event`。
- v6 去掉命名空间，服务名就是 `NewService` 传入的名字；`micro run` 自带网关规则 `/api/{service}/{Handler.Method}`（`cmd/micro/gateway/server.go#L922-923,964`）。

### 12 设计理念

- “sane defaults with a pluggable architecture”：所有抽象都是 Go interface，插件与核心同仓（ADR-001）；配置按“零配置 → 环境变量 → 代码选项”逐级加码（ADR-009）。
- 自我定位 “Batteries included”，适合 “conventions over decisions” 的团队（`guides/comparison.md#L31,44`）。
- 反射是有意为之：社区提议用泛型取代反射（[#2782](https://github.com/micro/go-micro/issues/2782)，2026-02-03 关闭），评估文档结论为保留反射（`internal/website/content/en/docs/REFLECTION-EVALUATION-SUMMARY.md#L100,121`；该文档署名 GitHub Copilot，性能数字自称 Hypothetical）。
- 2026 年的新说法：服务是 “named, network-addressable, typed, independently deployable unit”，“A registration is a tool definition”；“怎么创建服务”应该只有 “exactly one answer”（`the-evolution-of-microservices.md#L52,62`、`developer-experience-cleanup-one-way-to-do-things.md#L93,107`）。
- 作者回顾：v2 拿了风投，“framework and company were like oil and water”；v3 做成 PaaS，“too opinionated”；v4/v5 回到开发者框架；v6 “leads with agents... not a rewrite”（`bringing-an-open-source-project-back-from-the-dead.md#L20-50`）。

### 13 值得借鉴的范式

1. 契约不绑定服务名：`NewXService(name, c)` 到构造时才传服务名，同一份契约可以指向不同部署或测试桩。
2. endpoint 名由契约定义方决定：生成器写死 `Greeter.Hello`，再用同名局部类型包住实现。
3. 服务名和 endpoint 名分开放在两个请求头里：代理、网关和直连都能在不了解业务的情况下转发。
4. 注册时一起发布 endpoint 的 schema 和元数据：网关、`micro call`、MCP 工具和文档都能从运行中的系统生成。
5. 按 endpoint 配置调用选项，三层优先级明确（默认 < endpoint 级 < 单次调用），截止时间取较早者。
6. wrapper 能看到 `Service()` 和 `Endpoint()`，auth、trace、metrics 用同一套机制实现。
7. CallWrapper 在重试和选节点的里层，“单次尝试”和“整次调用”可以分开处理。
8. 结构化错误统一用 HTTP 状态码表达语义，跨进程后还能 `errors.Is`。
9. ctx 带着 metadata，超时通过请求头传下去再变成截止时间。
10. 按 content-type 选编码器，同一个 handler 能同时服务 JSON、protobuf 和 gRPC 客户端。
11. 订阅者也是 endpoint，而且能声明队列。
12. 契约里直接写描述和示例，一份契约同时生成文档、API 浏览器和 AI 工具描述。
13. 渐进式零配置、生命周期钩子和 `NewGroup` 多服务同进程。
14. `WaitForService` 配合 404/503 两种发现错误，区分“服务不存在”和“注册中心挂了”。

### 14 代价与被诟病之处

1. 反射魔法导致错误被悄悄吞掉：签名写错的方法只打日志就跳过，要到调用时才发现；去反射的诉求被拒。
2. endpoint 是字符串，还跟 Go 类型名绑在一起：不用代码生成时要手写 `"Say.Hello"`；struct 改名，线上契约就断了。
3. response 是出参，类型系统帮不上忙；普通方法和流式方法签名不一致。
4. 注册中心里的 schema 信息很少（只记类型名、最多 3 层、无必填和枚举），MCP 网关只好再解析一遍 struct tag。
5. 默认协议下错误是请求头里的一段 JSON 字符串，普通 error 会丢状态码。
6. 隐藏的全局状态和选项顺序陷阱（`Init` 改写全局 store、换 gRPC server 后名字丢失、默认 selector 的 `Mark` 是空函数等）。
7. metadata 没有白名单，token 和内部请求头会顺着调用链扩散。
8. 生态和 API 不稳定：模块路径换了五次，经历过改名和许可波折，示例仓库被删，推荐写法短期内反复。

---

## 两家对比、共识与教训

### 1 对比

|                | go-kratos v3                                                  | go-micro v6                                                            | LikeGo（拟议）                                                            |
| -------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 契约从哪来     | `api/<领域>/<版本>/` 下的 proto，生成 gRPC/HTTP 绑定          | 默认反射：struct 的方法就是 endpoint；proto 生成可选                   | `api/<svc>/v1` 下的 TS 模块：`service(...)` + `endpoint(...)`，不需要生成 |
| 操作名         | `/todo.v1.TodoService/GetTodo`，以生成常量导出                | `Greeter.Hello`（类型名.方法名）                                       | `payments.v1/pay`，由 endpoint 对象承载                                   |
| 发现名         | 应用名，`discovery:///beer.user.service`                      | 构造客户端时传入：`NewGreeterService(name, c)`                         | `newClient(withService("payments-http"), …)`                              |
| 实现签名       | `(ctx, *Req) (*Reply, error)`                                 | `(ctx, *Req, *Rsp) error`，响应是出参                                  | `(ctx, request) => response`                                              |
| 注册           | `v1.RegisterTodoServiceServer(srv, impl)`                     | `service.Handle(h)`，或 `RegisterGreeterHandler(s, h)`                 | `registerService(server, payments, impl)`                                 |
| 调用           | `v1.NewTodoServiceClient(conn).GetTodo(ctx, req)`             | `pb.NewGreeterService("greeter", c).Hello(ctx, req)`                   | `client.call(ctx, payments.pay, req)`                                     |
| 按操作挂中间件 | `selector.Server(mw).Prefix(...)`、`srv.Use(pattern, mw)`     | wrapper 里比较 `req.Endpoint()`；`EndpointOptions["service/Endpoint"]` | 拟议 `use(payments, mw)`、`use(payments.refund, mw)`（早期草案未定）      |
| 错误           | `{code, reason, message, metadata}`，reason 可在 proto 里声明 | `{id, code, detail, status, reason, domain}`                           | 现有 `ServiceError {code, message, status, metadata}`；契约内声明待定     |

### 2 两家的共识（原调查中的 LikeGo 状态）

- 契约里的服务身份和部署用的发现名是两回事。
- 线上名字由契约决定，不由实现类决定。
- 一份实现可以注册到多个 server。
- handler 用返回值（kratos）；go-micro 的出参写法沿袭自 `net/rpc`。

### 3 两家的教训（LikeGo 要避开）

- kratos 生成了操作名常量，大家还是在手写字符串；手写 HTTP 路由不经过中间件链，操作名退化成路径模板。
- go-micro 遇到签名写错的方法只打日志就跳过，要等调用时才发现。
- go-micro 的 endpoint 名跟着 Go 类型名走，struct 一改名，线上契约就断了。
- go-micro 的 metadata 全量透传；kratos 用前缀和 allowlist 控制传播。

### 4 协议与发现名的差异

- kratos 在一个应用名下同时注册 `grpc://` 和 `http://` 地址，客户端按自己的协议挑选；原调查中的 LikeGo 为 HTTP 和 gRPC 各用一个发现名（`orders-http`、`orders-grpc`）。

---
