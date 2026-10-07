# LikeGo Endpoint 契约 DX 设计记录（工作稿）

> 日期：2026-09-27
>
> 状态：设计进行中。第一段（对外定义层）、第二段（服务端实现与注册）已确认；go-kratos / go-micro 调研结论已被接受；下一步是第三段「范围与迁移」。
>
> 用途：把已经确定的设计、全部调研和依据写下来，防止聊天上下文丢失。定稿后再按 brainstorming 流程写正式 spec（默认放在 `docs/superpowers/specs/`，以用户意见为准）。
>
> 文中所有新 API 都是**拟议**，尚未实现。

## 目录

0. 快速恢复
1. 背景与来源
2. 已确定的决策
3. 设计第一段：对外定义层（已确认）
4. 设计第二段：服务端实现与注册（已确认）
5. LikeGo 的独有范式（调研后确立）
6. 待定事项
7. 现有代码事实（设计依据）
8. 调研方法与抽查
9. 调研：go-kratos v3
10. 调研：go-micro v6
11. 两家对比、共识与教训
12. 附录 A：side chat 还原记录
13. 附录 B：流程状态与恢复步骤

---

## 0. 快速恢复

**一句话**：像 go-kratos 一样契约优先，但契约本身就是 TypeScript 代码，不需要代码生成；契约里的 endpoint 对象同时充当类型、路由键和操作名，所有需要指向某个操作的地方都直接用它，调用处和配置里不再出现 service/method 字符串。

**当前拟议形态**：

```ts
// src/api/payments/v1/index.ts：对外定义层，只有契约
import { endpoint, service } from "@go-like/transport"

export const payments = service("payments.v1", {
  pay: endpoint({ request: PayRequest, response: PayResponse }),
  refund: endpoint({ request: RefundRequest, response: RefundResponse })
})
```

```ts
// src/internal/service/payments.ts：实现（对应 kratos 的 internal/service）
import type { ServiceHandler } from "@go-like/server"
import { payments } from "../../api/payments/v1"

export function newPaymentsService(repo: PaymentRepo): ServiceHandler<typeof payments> {
  return {
    async pay(ctx, request) {
      const payment = await repo.create(ctx, request)
      return { paymentId: payment.id, status: "success" }
    },
    async refund(ctx, request) {
      /* ... */
    }
  }
}
```

```ts
// src/internal/server/http.ts：装配（对应 kratos 的 internal/server）
const server = newServer(transport(newNodeHTTPTransport()), address("0.0.0.0:9000"))
registerService(server, payments, newPaymentsService(repo))
```

```ts
// 另一个服务的 src/internal/data/payments.ts：调用方（kratos 把下游 client 放在 data 层）
const client = newClient(
  withService("payments-http"),
  withDiscovery(discovery),
  withTransport(newHTTPTransport())
)
const result = await client.call(ctx, payments.pay, { paymentId: "p-001" })
```

**下一步**：呈现第三段「范围与迁移」（待定项见 6.1），再呈现第四段「错误处理与测试」（见 6.2），然后写正式 spec → 自查 → 用户审阅 → 转 writing-plans。

---

## 1. 背景与来源

### 1.1 起点：Codex 主会话（已废弃）

- 会话：`codex://threads/01a0dcdd-c971-7df1-80df-1de3869f962e`，标题「分析分支设计与开发体验」，2026-09-26 开始，对 LikeGo 的 DX 做只读审查。
- 它的最终结论（2026-09-27 05:57）：
  - 以 `endpoint(...)` → `server.registerHandler(endpoint, handler)` → `client.call(ctx, endpoint, request)` 作为内部 TypeScript unary 调用的标准路径；
  - 不引入 `server.register`、`registerEndpoint`、`endpoint.handler()` 等别名；
  - 不让 Endpoint 携带业务实现；
  - 不合并内部 HTTP registrar 与 Protobuf/Connect registrar；
  - 不重构生命周期、Transport 或 Registry。
- **用户已明确：主会话的结论废弃，以 side chat 沟通出的新 DX 为准。**
- 工作区里还留着主会话改过、尚未提交的三个 README：`README.md`、`packages/client/README.md`、`packages/transport/grpc-buf/README.md`。它们与本设计无关，实施前由用户决定提交还是丢弃。

### 1.2 新 DX 的来源：side chat

- 线程：`01a0dfd7-77f8-75c0-ae73-c7179be184e8`，是主会话的 side chat，标题「我有个想法，我看见过一种库…」，时间 2026-09-27 06:32–07:36（本地时间），模型 gpt-6-astra。
- 它是临时线程，没有写 rollout，10:37:49 空闲过期被回收。
- 还原方式：
  - 用户 9 轮输入：取自 `~/.codex/logs_2.sqlite` 里的 TurnInput 提交记录，以及 `~/.codex/.codex-global-state.json` 的 `prompt-history`；
  - 第 7–9 轮助手回复：从 Codex Desktop 窗口的无障碍树读出（当时界面内存里还在）；
  - 第 1–6 轮助手回复：无法还原，但已被后续回复取代。
- 完整还原记录见附录 A；另有备份 `/tmp/likego-side-chat-01a0dfd7.md`（/tmp 可能被系统清理）。

用户在 side chat 里的要求与否决（按时间顺序）：

1. 想要一种库：一次定义好 client、server 都能用的 handle，export 给各模块 import，不需要手写 server name 和 call name，而且是强类型。
2. 否决 `defineService`。
3. 否决 `callQuote`、`registerQuote` 这类生成函数；想要的是 `endpoint({ name, request, response, handle })`，client 用 `client.call(ctx, payHandle, {...})`，server 用 `registerService('payments', payHandle)`。
4. handle 不需要写 service 名字，handle 本意只是定义调用函数。
5. `endpoint` 可以叫 `defineHandle('pay', {...})`；client import 这个 handle，就能拿到强类型的 request、response 和 handle name。
6. 类似现代 JS Web 框架的 “End-to-End” 设计。
7. `registerService(server, name, {pay, login, getUser})`；client 甚至不需要 export 单个 handle，直接 export service。
8. （批注）否决 `client.bind("payments", payments)`，要求先联网调研别人的 End-to-End 设计理念，再打造 LikeGo 独有的方案。

side chat 的最终方案（07:36）：

- `defineHandle(name, { request, response, handle })` + `registerService(server, serviceName, service)` + `client.call(ctx, service.handle, request)`；
- 调研了 tRPC、Hono RPC / Elysia Eden、ts-rest / oRPC；
- 浏览器 bundle 会打进服务端实现的问题，留给以后的 client-only contract projection。

其中「handle 携带实现」和「`defineHandle` 命名」两点，已在本轮被替换（见决策 D3、D4）。

### 1.3 本轮讨论（Cursor，2026-09-27）

- 按 superpowers:brainstorming 流程推进：摸清上下文 → 逐个澄清 → 给出方案 → 分段呈现设计并逐段确认。
- 用户的三条关键回答：
  1. 客户端从哪里拿到服务名：参考 go-kratos 的项目目录结构，那里有一个专门定义对外 API 的地方（`api/`）。
  2. key 和 name 写两遍：一个是在 service 上直接访问用的名字，一个是 handle 真实的函数名（类似 gRPC）；是否冗余还在设计中。
  3. 与主会话结论相反：主会话废弃，side chat 才是新 DX。
- 之后用户选择「对外定义层只放契约」，并提议沿用 `endpoint` 这个名字、把它看作“充血模型”。
- 第二段呈现后，用户要求先调研 go-kratos 和 go-micro 的文章与示例代码，学习它们的范式；调研结论已被接受（第 8–11 节）。

---

## 2. 已确定的决策

| 编号 | 决策                                                                                                                                                                       | 来源                                         |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| D1   | 主会话结论废弃，以 side chat 的新 DX 为准                                                                                                                                  | 用户明确                                     |
| D2   | 设立“对外定义层”（对应 kratos 的 `api/`），客户端从这里拿到服务名                                                                                                          | 用户：参考 go-kratos 目录结构                |
| D3   | 对外定义层**只放契约**：服务名 + 各 endpoint 的 request/response。实现写在服务内部，注册时挂上去；其他服务 import 契约时不会带上服务端代码                                 | 用户选择“只放契约”                           |
| D4   | 这个“点”继续叫 `endpoint`（取代 `defineHandle`），它是“充血模型”：一个不可变对象带齐所有信息                                                                               | 用户提议，已确认                             |
| D5   | “充血”指信息完整、由框架函数消费；**不给 endpoint 加 `call()`、`implement()` 等方法**，避免出现两种调用方式；按 D3，endpoint 也不能带实现                                  | 第一段确认                                   |
| D6   | `service(name, { key: endpoint({...}) })`：服务名只写一次；方法名取自对象键，也只写一次（方案 A）。将来需要对接已有线上名字时，再给 `endpoint({...})` 加可选的 `name` 覆盖 | 第一段确认                                   |
| D7   | 组装后的 Endpoint 形状为 `{ service, name, request, response }`；现有字段 `endpoint` 改名为 `name`                                                                         | 第一段确认                                   |
| D8   | 单独的 `endpoint({...})` 还不是完整的点（没有 service 和 name）；`client.call` 只接受 `service(...)` 组装后的 endpoint，用错在编译期报错                                   | 第一段确认                                   |
| D9   | 发现名不变：仍在 `newClient(withService("payments-http"), …)` 构造时指定，它是部署身份，对应 kratos 的应用名                                                               | 第一段确认；两家共识                         |
| D10  | 服务端用 `registerService(server, service, handler)` 注册，规则见第 4 节                                                                                                   | 第二段；调研后维持                           |
| D11  | 约定服务名带版本号，如 `service("payments.v1", …)`；不兼容变更时新建 v2 契约，同一个 server 可以同时注册 v1 和 v2                                                          | 调研结论（kratos 的 package 版本化），已接受 |
| D12  | 约定用 `package.json` 的 `exports` 只导出 `./api` 来守住契约边界，效果相当于 Go 的 `internal/` 目录；细节写进第三段的示例规范                                              | 调研结论，已接受                             |
| D13  | 约定把调用其他服务的 client 放在 data 层，藏在业务层声明的接口后面                                                                                                         | 调研结论（kratos 做法），已接受              |
| D14  | 不提供 kratos 式的 `Unimplemented...` 基类：新增 endpoint 时让编译直接报错，逼着把实现补上                                                                                 | 第二段；调研后维持                           |
| D15  | 保留原始 API：`registerHandler(service, endpoint, handler)` 与 `client.call(ctx, CallRequest)`                                                                             | 第二段                                       |
| D16  | 接受 `endpoint` 一词的双重含义（它在 LikeGo 里还指网络地址，见 7.4），地址那一侧的命名清理单独再议                                                                         | 第一段确认                                   |

**被否决或被替换、不要再提的方案**：

- 把 `defineService` 作为主要定义单位（side chat 否决）。注意：现在的 `service(...)` 只负责把 endpoint 组合起来并声明服务名；函数名是暂定的，刻意避开了 `defineService`，第一段已确认。
- `callQuote`、`registerQuote`、`newPaymentsClient` 这类按操作或按服务生成的函数（side chat 否决）。
- 在 handle/endpoint 的定义里写服务名（side chat 否决）。
- `client.bind("payments", payments)`，以及由它绑定出来的 `paymentsClient.pay(ctx, req)` 写法（side chat 否决）。
- `defineHandle` 这个命名（本轮改为 `endpoint`）。
- handle 携带实现、客户端 import 服务端实现（本轮改为只放契约）。

---

## 3. 设计第一段：对外定义层（已确认）

### 3.1 写法

```ts
// src/api/payments/v1/index.ts：对外定义，只有契约，客户端和服务端都 import 这里
import { endpoint, service } from "@go-like/transport"

export const payments = service("payments.v1", {
  pay: endpoint({ request: PayRequest, response: PayResponse }),
  login: endpoint({ request: LoginRequest, response: LoginResponse }),
  getUser: endpoint({ request: GetUserRequest, response: UserResponse })
})
```

组装之后，`payments.pay` 就是信息完整的点：

```ts
interface Endpoint<Request extends Struct, Response extends Struct> {
  readonly service: string // "payments.v1"：路由身份，来自 service(...)
  readonly name: string // "pay"：来自对象键（现有字段叫 endpoint，改名为 name）
  readonly request: Request // 编译期推导类型，运行时校验
  readonly response: Response
}
```

两侧都直接用它，调用处不再出现字符串：

```ts
registerService(server, payments, {
  async pay(ctx, request) {
    /* ... */
  },
  async login(ctx, request) {
    /* ... */
  },
  async getUser(ctx, request) {
    /* ... */
  }
})

const result = await client.call(ctx, payments.pay, { paymentId: "p-001" })
```

### 3.2 规则与理由

- **名字只写一次（方案 A）。** 服务名写在 `service(...)` 里，方法名取自对象键。“充血”体现在组装后的 `payments.pay` 内部已经有 service 和 name，定义处没必要再写一遍字符串；gRPC 里开发者也只写一次 `rpc Pay`，本地方法名是生成出来的（Connect-ES 生成 `pay` 作为本地名、`Pay` 作为线上名）。
  - 代价：改键名就是改线上名字，和改 proto 的 rpc 名一样；不兼容变更靠版本化的服务名解决（D11）。
  - 当时的备选：B「`pay: endpoint("Pay", {...})`，本地键 + 显式线上名」；C「键默认当名字，需要时覆盖」。选 A，C 的覆盖能力留作以后的扩展。
- **单独的 `endpoint({...})` 不是完整的点。** 类型上，`client.call` 只接受 `service(...)` 组装后的 endpoint。
- **发现名不变。** `newClient(withService("payments-http"), ...)` 里的名字是部署身份；现行文档里 HTTP 服务的发现名 `orders-http` 本来就和路由名 `orders` 不同。
- **包的位置。** `endpoint`、`service`、`Endpoint`、`Service` 放在 `@go-like/transport`，这是现有 `endpoint` 所在的包，client 和 server 都依赖它。`service`、`Service` 这两个名字目前没有被任何包占用（请求头常量没有从 `@go-like/transport` 入口导出）。
- **服务名带版本号（D11）。** 例如 `"payments.v1"`，照搬 kratos 的 `package todo.v1`。现有路由 token 规则（可见 ASCII，不含 `/`、`*`）允许点号。
- **契约边界（D12）。** 服务包在 `package.json` 的 `exports` 里只导出 `./api`，其他服务只能 import 契约，拿不到实现。
- **不给 endpoint 加方法（D5）。** 行为留在 `client.call`、`registerService` 等函数里。
- **命名代价（D16）。** `endpoint` 在 LikeGo 里还指网络地址，例如 `server.endpoint(ctx)`、`@go-like/core` 的应用选项 `endpoint(...)`、注册中心的 `ServiceInstance.endpoints`；几乎每个示例都会调用 `httpServer.endpoint(ctx)`。两种含义会同时出现，已经接受。
- **以后可以扩展的位置。** `endpoint({...})` 的参数对象以后可以加可选 `name` 覆盖、HTTP 映射（像 kratos 在 proto 里写 `google.api.http`）、描述和示例等元数据。第一版不做，见 6.3。

---

## 4. 设计第二段：服务端实现与注册（已确认）

核心只有一个函数 `registerService(server, payments, handler)`。它逐个调用现有的 `registerHandler(endpoint, handler)`，所以 JSON 编解码、Struct 校验（请求不合法返回 400、响应不合法返回 500）、ServiceError、重复注册检测、启动后禁止注册这些行为都保持不变。

```ts
// src/internal/service/payments.ts：实现
import type { ServiceHandler } from "@go-like/server"
import { payments } from "../../api/payments/v1"

export function newPaymentsService(repo: PaymentRepo): ServiceHandler<typeof payments> {
  return {
    async pay(ctx, request) {
      // ctx、request 的类型都从契约推导
      const payment = await repo.create(ctx, request)
      return { paymentId: payment.id, status: "success" }
    },
    async login(ctx, request) {
      /* ... */
    },
    async getUser(ctx, request) {
      /* ... */
    }
  }
}
```

```ts
// src/internal/server/http.ts：装配
const server = newServer(transport(newNodeHTTPTransport()), address("0.0.0.0:9000"))
registerService(server, payments, newPaymentsService(repo))
```

`@go-like/server` 新增的类型和函数：

```ts
export type ServiceHandler<S extends Service> = {
  readonly [K in keyof S]: TypedHandler<S[K]["request"], S[K]["response"]>
}

export function registerService<S extends Service>(
  server: HandlerRegistrar,
  service: S,
  handler: ServiceHandler<S>
): void
```

和 kratos 的对应关系：

| kratos                                    | LikeGo                                    |
| ----------------------------------------- | ----------------------------------------- |
| `v1.TodoServiceServer` 接口               | `ServiceHandler<typeof payments>`         |
| `service.NewTodoService(uc)`              | `newPaymentsService(repo)`                |
| `v1.RegisterTodoServiceServer(srv, impl)` | `registerService(server, payments, impl)` |

规则：

- **必须全部实现。** 编译期由 `ServiceHandler` 保证。运行时，`registerService` 会在注册任何一个 endpoint 之前，先检查每个 endpoint 都有对应的函数，缺了直接抛错，不会出现注册了一半的情况。不提供 `Unimplemented...` 基类（D14）：契约和实现一起演进；旧服务还没实现新 endpoint 时，调用方拿到的是现有的“未知路由”错误。
- **保留 `this`。** 注册时把方法取下来，调用时以实现对象作为 `this`，所以 class 实例也能用（kratos 那种带依赖的 struct 写法）。推荐工厂函数返回对象字面量：参数类型能从契约自动推导；class 方法不会从 `implements` 推导参数类型，要自己标注。
- **多余成员不报错。** 运行时忽略契约里没有的成员（class 上本来就有依赖字段和私有方法）；对象字面量写错键名时，TypeScript 会报多余属性错误。
- **沿用现有注册规则。** 同一个 server 可以注册多个服务；同一个服务注册两次、或者启动后再注册，会得到现有的“重复注册”和“注册已封口”错误；同一个实现对象可以注册到多个 server（比如 HTTP 和 Memory）。
- **不绑定具体 server。** `registerService` 只依赖 `HandlerRegistrar` 接口，任何实现了这个接口的 server 都能用。
- **底层 API。** 带类型的 `registerHandler(endpoint, handler)` 是否继续公开，第三段定（见 6.1）；原始的 `registerHandler(service, endpoint, handler)` 保留（D15）。

调研对第二段的印证：handler 用返回值（同 kratos，不用 go-micro 从 `net/rpc` 沿袭的出参）；实现不完整时注册直接失败（吸取 go-micro 悄悄跳过不合格方法的教训）；线上名字取自契约（同 protoc-gen-micro 用同名局部类型包住实现的做法）。

---

## 5. LikeGo 的独有范式（调研后确立）

- **定位**：像 kratos 一样契约优先、契约与实现分离；像 go-micro 的反射那样直接，不需要 IDL 和代码生成；像 tRPC 一样端到端强类型；同时保留微服务框架该有的发现、选择、传输和 ctx-first。
- **核心**：endpoint 对象本身就是“操作”。kratos 要靠四样东西才能做到这些：生成的操作名常量、生成的客户端、生成的注册函数，以及中间件配置里的字符串。LikeGo 用一个对象覆盖：

```ts
// src/api/payments/v1/index.ts
export const payments = service("payments.v1", {
  pay: endpoint({ request: PayRequest, response: PayResponse }),
  refund: endpoint({ request: RefundRequest, response: RefundResponse })
})

// src/internal/server/http.ts
const server = newServer(
  transport(newNodeHTTPTransport()),
  use(payments, authMiddleware), // 整个服务，相当于 kratos 的 Prefix("/payments.v1/")
  use(payments.refund, auditMiddleware), // 单个操作，相当于 Path(...)
  httpRoute("POST", "/v1/payments", payments.pay)
)
registerService(server, payments, newPaymentsService(repo))

// 另一个服务的 src/internal/data/payments.ts
const client = newClient(
  withService("payments-http"),
  withDiscovery(discovery),
  withTransport(newHTTPTransport())
)
await client.call(ctx, payments.pay, { paymentId: "p-001" })
```

- `use(payments, …)`、`use(payments.refund, …)`、`httpRoute(…, payments.pay)` 是否这样改，第三段定。服务端 `use` 现在已经支持精确操作名 `"payments.v1/refund"` 和整个服务 `"payments.v1/*"`，这里只是把字符串换成对象。
- `client.call(ctx, payments.pay, req)` 相当于 kratos 生成的客户端底层调用的 `conn.Invoke(ctx, FullMethodName, …)`。因为 endpoint 自带类型，LikeGo 不需要再生成一层客户端，调用处的类型检查一样完整。
- 一个 `Client` 实例对应一个发现目标（`withService`），相当于 kratos 的一条 `conn` 或 go-micro 的 `NewXService(name, c)`。

---

## 6. 待定事项

### 6.1 第三段：范围与迁移（下一步，附当前倾向）

1. **替换现有的 `endpoint(service, name, request, response)`。** 倾向：直接替换为 `endpoint({ request, response })` + `service(name, endpoints)`，不留兼容层；各包都是 0.0.1，没有发布到 npm。
2. **字段改名范围。** 契约 `Endpoint` 的 `endpoint` 字段改为 `name`（已定）。原始 `CallRequest` 的 `endpoint` 字段要不要跟着改？倾向：不改，它对应线上请求头 `Go-Like-Endpoint`。
3. **带类型的单 endpoint `registerHandler(endpoint, handler)` 是否继续公开。** 倾向：从 `HandlerRegistrar` 接口移除，带类型的注册只走 `registerService`（内部复用 `typedHandler` 编解码后调用原始重载），`HandlerRegistrar` 只保留 Message 级的原始重载。
4. **服务端和客户端的 `use(...)` 接收 endpoint 与 service。** endpoint 对应精确操作，service 对应整个服务（等价于 `"service/*"`）；保留字符串写法，用于 `*` 等通配。倾向：做。
5. **`httpRoute(method, path, endpoint, successStatus?)`。** 字符串版本保留给原始 handler。倾向：做。
6. **错误码进契约**（kratos `ErrorReason` 枚举的对应物）。LikeGo 的 `ServiceError` 已经是 `{code, message, status, metadata}`。倾向：单独设计，不进本次范围；待用户定。
7. **迁移清单**（见 7.3）：packages 源码里读取契约字段的地方、约 10 个包内测试文件、5 个走内部 RPC 的示例、根 `README.md`（L138、L318、L323 描述了现有契约与注册写法）、4 个包 README（client、core、server、transport）、文档站 `doc/`（英文源文档 + 7 个语言译本）、`docs/developer-experience-alignment.md`、`docs/editorial-blueprint.md`；新增一篇 ADR 记录本设计。文档站译本是否与英文同步修改，待用户定（仓库没有强制译本同步的检查，`doc:build` 是普通的 `vitepress build doc`）。
8. **示例规范。** 采用 kratos 式目录：`src/api/<svc>/v1`、`src/internal/service`、`src/internal/data`、`src/internal/server`、`src/main.ts`；`package.json` 的 `exports` 只导出 `./api`。至少一个多服务示例完整演示跨服务调用（候选 `commerce-catalog`：catalog 调用 pricing，目前是原始字符串 `"pricing"`、`"Pricing.Get"` 加手写编解码）。
9. **明确不变。** Protobuf/Connect 路径（`protoc-gen-like`、`@go-like/transport-grpc-buf` 生成的 registrar 和 client）、生命周期、Transport、Registry、Selector，以及地址含义的 `endpoint` API。
10. **实施前清理。** 主会话遗留的三个未提交 README 修改如何处理，由用户决定。

### 6.2 第四段：错误处理与测试

- **定义期校验**：
  - 服务名和对象键都必须是合法路由 token（可见 ASCII，不含 `/`、`*`）；
  - 键不能与 `Object.prototype` 上的属性同名（如 `toString`、`constructor`、`__proto__`），否则运行时查找实现方法可能拿到原型上的函数；
  - request/response 必须是真正的 Struct（沿用 `isStruct` 检查）；
  - 至少一个 endpoint；
  - 产物冻结；`service()` 的产物打品牌，防止结构仿冒对象通过。
- **注册期**：
  - 缺方法时，在注册任何 endpoint 之前失败；
  - 注册时取下方法，调用时以实现对象为 `this`；
  - 与已注册路由冲突时沿用现有的重复错误。冲突之前的 endpoint 已经注册进去，按启动失败处理；或者改成先整体检查再注册（待定）。
- **调用期**：`client.call` 拒绝未组装的 endpoint 和仿冒对象。
- **测试**：
  - 沿用 `packages/*/test/public-types.ts` 的类型测试，用 `@ts-expect-error` 覆盖缺方法、多余键、请求/响应类型错误；
  - 单元测试：service/endpoint 校验，`registerService` 的各项行为（含 class 实例的 `this`）；
  - 沿用 HTTP/Memory transport 的 e2e；
  - 迁移后的示例都要能编译并通过测试。

### 6.3 以后再议（不在本次范围，除非用户拉进来）

- 按 endpoint 配置客户端调用选项（go-micro v6.14 `EndpointOptions` 的对应物，键用 endpoint 对象）。
- endpoint 元数据：描述、示例（go-micro v6 用注释和 `@example` 生成文档与 MCP 工具描述）。
- 契约级 HTTP 映射（kratos 在 proto 里写 `google.api.http`）。LikeGo 内部 client 不走 REST 路径，收益比 kratos 小。
- 把 endpoint schema 发布到注册中心（go-micro 的 `registry.Endpoint`；已被替代的 ADR 0008 早期方案也有类似设计）。
- 在契约里声明幂等性，用于重试授权。
- endpoint 的可选 `name` 覆盖（对接已有线上名字）。
- 浏览器或第三方 SDK 的客户端入口：契约只放契约后已经天然满足，side chat 里说的 projection 不再需要。
- 一个应用名下同时注册多个协议地址、客户端按 scheme 挑选（kratos 做法），用来替代现在 `orders-http`、`orders-grpc` 两个发现名。
- 清理地址含义的 `endpoint` API 命名。

---

## 7. 现有代码事实（设计依据）

### 7.1 契约、服务端、客户端

| 位置                                                | 现状                                                                                                                      |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `packages/transport/src/endpoint.ts` L5–10          | `Endpoint<Request, Response>` 有 `service`、`endpoint`、`request`、`response` 四个只读字段                                |
| `packages/transport/src/endpoint.ts` L13–39         | `endpoint(service, name, request, response)` 校验路由 token（可见 ASCII、不含 `/` 和 `*`）和真正的 Struct，返回冻结对象   |
| `packages/transport/src/index.ts` L2、L12           | 导出 `endpoint` 与 `Endpoint` 类型；没有导出 `service`                                                                    |
| `packages/transport/src/headers.ts`                 | `request = "Go-Like-Service"`、`endpoint = "Go-Like-Endpoint"` 等请求头常量（未从入口导出）                               |
| `packages/transport/src/types.ts` L41–46            | `ServiceError { name, code, status, metadata }`                                                                           |
| `packages/transport/src/errors.ts` L143、L170、L176 | `serviceError(code, message, status = 500, metadata)`、`isServiceError`（品牌检查）、`internalServiceError()`             |
| `packages/server/src/index.ts` L39、L42–45          | `Handler`（Message 级）与 `TypedHandler<Request, Response> = (ctx, request) => Response \| Promise<Response>`             |
| `packages/server/src/index.ts` L74–81               | `HandlerRegistrar` 有两个重载：`registerHandler(endpoint, typedHandler)` 与 `registerHandler(service, endpoint, handler)` |
| `packages/server/src/index.ts` L89                  | `Server.endpoint(ctx)` 返回真实绑定地址（地址含义）                                                                       |
| `packages/server/src/index.ts` L162–181             | 中间件选择器只接受精确 `"service/endpoint"`、末尾单个 `*` 的前缀，或 `"*"`                                                |
| `packages/server/src/index.ts` L394–431             | `typedHandler`：检查 JSON Content-Type 并解码校验，失败抛 `invalid_request`/400；响应编码校验失败抛 `internal`/500        |
| `packages/server/src/index.ts` L486–489             | `use(selector: string, ...middleware): ServerOption`                                                                      |
| `packages/server/src/index.ts` L535–541             | `httpRoute(method, path, service, endpoint, successStatus?)`                                                              |
| `packages/server/src/index.ts` L815–861             | `registerHandler` 实现：封口后抛 “server registration is sealed”；重复抛 “server handler is duplicated: service/endpoint” |
| `packages/server/src/index.ts` L873–900             | `seal()`：至少一个 handler；`httpRoute` 的目标必须已注册                                                                  |
| `packages/client/src/index.ts` L525–544             | `CallRequest { service, endpoint, message }`；`Client.call` 有带类型（`NoInfer<Infer<Request>>`）和原始两个重载           |
| `packages/client/src/index.ts` L643–657             | `isEndpoint` 等结构检查读取 `service`、`endpoint` 字符串字段                                                              |
| `packages/client/src/index.ts` L737–753             | `withService(value)`：“Configures the Discovery service identity for every future call”                                   |
| `packages/client/src/index.ts` L850–853             | 客户端 `use(selector: string, ...ClientMiddleware)`                                                                       |
| `packages/client/src/index.ts` L1377                | 服务发现用的是 client 配置的 `source.service`，不是请求里的 service                                                       |
| `packages/client/src/index.ts` L1455–1466、L1497    | 每次调用把请求的 service/endpoint 写进请求头；操作中间件的键是 `${service}/${endpoint}`                                   |
| `packages/client/src/index.ts` L1535–1591           | 带类型的调用：重新校验契约，JSON 编码请求，按响应 Struct 校验解码                                                         |
| `packages/client/src/index.ts` L1620–1645           | `newClient`：走服务发现时必须 `withService`；`withService` 必须配合服务发现；否则必须提供直连地址                         |

### 7.2 现行文档与决策

- `docs/developer-experience-alignment.md` L128–130：HTTP 示例里的 `newOrderServiceClient` / `registerOrderServiceHandler` 是应用基于 `Endpoint` 和 `HandlerRegistrar` **手写的胶水**；`protoc-gen-like` 不生成 Struct HTTP client。
- 同一文档 L150–158：服务发现时，HTTP 用 `withService("orders-http")`，标准 gRPC 用 `orders-grpc`。L211、L213 是 Client 和 Server 的现行约定表。
- `docs/adr/0008-service-declaration-and-registration.md`：早期的 `ServiceDeclaration`（服务名、endpoint、handler 放在同一个声明里）方案，状态为“已被替代”。
- `packages/protoc-gen-like/README.md`：生成 `OrderServiceHandler`、`OrderServiceClient`、`registerOrderServiceHandler(server, handler)`、`newOrderServiceClient(client)`，形态与 kratos 一致。
- 各包版本都是 `0.0.1`，没有发布到 npm（`npm view @go-like/client` 返回 404）。

### 7.3 迁移面（已核实）

- **packages 源码中读取契约 `endpoint` 字段的地方**：
  - `packages/client/src/index.ts` L643、L654、L1564、L1573
  - `packages/server/src/index.ts` L400、L844、L849
  - `packages/otel/src/client.ts` L78（自带 `isEndpoint`）
  - `packages/pino/src/logging.ts` L185、L192，`packages/winston/src/logging.ts` L183、L217、L229，`packages/prometheus/src/index.ts` L178、L185：参数类型都是 `CallRequest | Endpoint`，都用 `${subject.service}/${subject.endpoint}` 拼操作名
- **调用契约 `endpoint("…")` 的包内测试**：`packages/transport/test/endpoint.test.ts`、`packages/transport/test/public-types.ts`、`packages/client/test/public-types.ts`、`packages/client/test/client.test.ts`、`packages/transport/http/test/e2e/node-e2e.ts`、`packages/core/test/public-types.ts`、`packages/server/test/server.test.ts`、`packages/core/test/app.test.ts`、`packages/pino/test/logging.test.ts`。
- **文档中调用契约 `endpoint("…")` 的地方**（跨行匹配）：`docs/editorial-blueprint.md`、`packages/transport/README.md`、`doc/guide/service-call.md`、`doc/guide/zero-to-one.md`，以及 zero-to-one 的 7 个语言译本（`doc/{ar-Arab,es-Latn,fr-Latn,ru-Cyrl,zh-Hans,zh-Hant-HK,zh-Hant-TW}/guide/zero-to-one.md`）。
- **提到 `registerHandler(`、`client.call(`、`httpRoute(` 的文档**（不一定都要改，原始写法可以保留）：
  - 包 README：`packages/client/README.md`、`packages/core/README.md`、`packages/server/README.md`（L54 提到带类型的 `server.registerHandler(contract, handler)`）、`packages/transport/README.md`；
  - 文档站英文：`doc/guide/{architecture,config-registry-store,health-observability,migration,service-call,zero-to-one}.md`、`doc/reference/{claims,providers}.md`；
  - 文档站每个译本：`guide/{migration,service-call,zero-to-one}.md`、`reference/providers.md`；`zh-Hans` 另有 `guide/health-observability.md`。
- **使用带类型 `registerHandler(contract, handler)` 的地方**：`packages/server/test/server.test.ts` L202、L268、L322、L384、L391；`packages/server/test/public-types.ts` L77、L110；`packages/transport/http/test/e2e/node-e2e.ts` L507；`examples/bank-transfer-gateway/src/transport.ts` L42。
- **走内部 RPC 的示例（5 个）**：
  - `bank-transfer-gateway`：已使用带类型的契约（`src/contract.ts`；`src/transport.ts` L42 注册、L53 调用）；
  - `commerce-catalog`：`src/pricing.ts` L157 `registerHandler("pricing", "Pricing.Get", handler)`、L130 原始 `client.call`；
  - `enterprise-platform-runtime`：`src/echo.ts` L18、L25，原始写法；
  - `healthcare-appointments`：`src/transport.ts` L48、L82，原始写法；`test/main.test.ts` L232；
  - `telecom-service-provisioning`：`src/transport.ts` L98–110 手写 `registerTelecomProvisioningHandler`，L120 原始 `client.call`。
  - 另有两个测试里的假 registrar：`commerce-catalog/test/app.test.ts` L74、`enterprise-platform-runtime/test/unit/runtime.test.ts` L77。
- **不在迁移面**：示例里大量 `endpoint(` 其实是地址含义的 `httpServer.endpoint(ctx)`，以及 `@go-like/core` 的应用选项 `endpoint(serviceEndpoint)`，与契约无关。

### 7.4 `endpoint` 一词的两种含义

- **地址含义**（kratos 用法）：`packages/core/src/app.ts` L26–31 `Endpointer.endpoint(ctx)`、L214–222 应用选项 `endpoint(...values)`；`packages/registry/src/types.ts` L10 `endpoints: readonly string[]`；`packages/server/src/index.ts` L89；`packages/web/src/node-server.ts` L24；`packages/transport/grpc-buf/src/server.ts` L462。
- **操作含义**（go-micro 用法）：`Endpoint<Req, Res>` 契约、`Go-Like-Endpoint` 请求头、服务端 service → endpoint 路由表、`CallRequest.endpoint`。

---

## 8. 调研方法与抽查

- 调研对象：go-kratos v3.0.0（2026-06-26 发布）、go-micro v6.14.0（2026-09-21 发布），都是当前最新版。
- 方式：派两个子代理并行只读调研（官方文档、项目模板、官方示例、多服务示例、代码生成器、核心源码、issue），要求每条结论附出处。浅克隆放在 `/tmp/kratos-research/`、`/tmp/gomicro-research/`（可能被清理）。
- 我在本地源码里亲自抽查过的结论：
  - kratos：`v3.0.0` tag；`Transporter.Operation()`；`selector` 的 `Server/Client/Prefix/Regex/Path/Match`；HTTP 和 gRPC server 都有 `Use(selector, m...)`；`internal/endpoint.ParseEndpoint` 按 scheme 挑地址；`Router.Handle` 不自动套中间件；beer-shop 用 `discovery:///beer.user.service` 等端点；v2 文档中 `errors.default_code` / `errors.code` 的写法；casbin 示例白名单手写 `"/admin.v1.AdminService/Login"`。
  - go-micro：模块路径 `go-micro.dev/v6`；`NewService(name string, opts ...Option)`；`service.Handle`；反射命名 `name + "." + e.Name`；`EndpointOptions map[string][]CallOption` 与 `ResolveCallOptions`；生成的 `NewGreeterService(name, c)`、`NewRequest(c.name, "Greeter.Hello", in)`、局部类型 `Greeter`；`registry.Service/Endpoint/Value` 结构；go-micro/demo 的 `pb.NewCartService(cfg.CartService, client)`；`WrapClient/WrapCall/WrapHandler/WrapSubscriber`；client 把 ctx metadata 和 `Timeout` 写入请求头；router 对不合格方法只打日志就 `return nil`；issue #2782「Remove reflect」于 2026-02-03 关闭。
- 未亲自复核、以子代理报告为准的细节，在下文照录出处。

---

## 9. 调研：go-kratos v3

### 9.1 版本基线

| 来源                    | 版本                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------- |
| go-kratos/kratos        | `v3.0.0`（main `668db92`）                                                              |
| go-kratos/kratos-layout | main `59ad406`（依赖 `kratos/v3 v3.0.0`，Go 1.25.7）                                    |
| go-kratos.dev           | main `8e0db39`；v3 文档由 PR #264（2026-09-21）重写；v2 版文档取历史提交 `e0e143a` 对照 |
| go-kratos/examples      | `61daed1`，仍用 `kratos/v2 v2.8.0`                                                      |
| go-kratos/beer-shop     | `f762a42`，仍用 `kratos/v2 v2.2.0`                                                      |

v3 变化的一手出处：[迁移指南 v2-to-v3.md](https://github.com/go-kratos/kratos/blob/v3.0.0/docs/migration/v2-to-v3.md?plain=1)、[#3820](https://github.com/go-kratos/kratos/issues/3820)。v2 → v3 主要是依赖清理（slog、json 与 protojson 拆分、JWT/OTel 移到 contrib、删除 binding 包）和 HTTP 流式生成，业务分层与 API 范式基本不变。

### 9.2 项目结构与分层

- `api/<domain>/<version>/` 是唯一对外契约（proto 源 + 生成物）；`cmd/<app>/` 是入口和 Wire 组合根；`internal/server` 构造 transport、挂中间件、注册服务；`internal/service` 是 transport 适配层，做 DTO↔DO 转换；`internal/biz` 放 DO、usecase、repo 接口和错误；`internal/data` 放 repo 实现、存储客户端和外部客户端；`internal/conf` 是配置 proto。
- 分层理由是 DDD / Clean Architecture 的依赖倒置：biz 声明自己需要的接口，data 在边缘实现。v3 文档强调 layout 只是模板约定，不是框架强制（[设计理念](https://go-kratos.dev/zh-cn/docs/intro/design/)）。
- **调用其他服务的 RPC client 放在 `internal/data`**，藏在 biz 声明的 repo 接口后面（[beer-shop data.go L84–101](https://github.com/go-kratos/beer-shop/blob/f762a42/app/shop/interface/internal/data/data.go#L84-L101)、[user.go L44–53](https://github.com/go-kratos/beer-shop/blob/f762a42/app/shop/interface/internal/data/user.go#L44-L53)）。
- 多服务共享 api：beer-shop 是单个 Go module，顶层 `api/<svc>/<kind>/v1` 供各 `app/*` 直接 import；v2 文档还给了“统一 proto 仓库”的备选。
- 客户端构造：`discovery:///<应用名>` + `WithDiscovery` 得到连接，再交给生成的 `NewXxxClient`；同一个应用名可以同时用 gRPC 和 HTTP 访问（[examples registry/etcd client L25–39](https://github.com/go-kratos/examples/blob/61daed1/registry/etcd/client/main.go#L25-L39)）。
- 分层规则写在 [kratos-layout AGENTS.md L41–46](https://github.com/go-kratos/kratos-layout/blob/59ad406/AGENTS.md?plain=1#L41-L46)：service 只 import api 和 biz；biz 只为错误原因枚举 import api；data import biz 实现 repo 接口；只有 cmd 通过 Wire 装配所有层。
- 版本差异：v3 模板删掉了 `third_party/`，改用 `buf.yaml` 依赖 googleapis；官方没有 v3 版的多服务示例。

### 9.3 API 定义范式

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

### 9.4 服务实现范式

- 一个嵌入 `v1.UnimplementedTodoServiceServer`、持有 `*biz.TodoUsecase` 的 struct，方法签名 `(ctx, *Req) (*Reply, error)`（[service/todo.go L26–57](https://github.com/go-kratos/kratos-layout/blob/59ad406/internal/service/todo.go#L26-L57)）。
- 一份实现同时满足 gRPC 和 HTTP 两个生成接口，在 server 层分别注册。
- service 层只做边界工作：校验 ID、DTO→DO、DO→DTO；不写业务规则，不碰存储。
- Wire：每层导出 `ProviderSet`；data 的构造函数返回 biz 接口；`NewData` 同时返回 cleanup（[wire.go L22–24](https://github.com/go-kratos/kratos-layout/blob/59ad406/cmd/server/wire.go#L22-L24)）。
- 测试放在被测包旁边：service 测试用“真实 usecase + 内存 fake repo”，用 `errors.IsNotFound` 断言错误语义（[todo_test.go](https://github.com/go-kratos/kratos-layout/blob/59ad406/internal/service/todo_test.go#L18-L21)）。

### 9.5 Server / Client 与 transport 抽象

- `http.NewServer` / `grpc.NewServer` 都用函数式 options，都实现 `transport.Server{Start, Stop}` 和 `transport.Endpointer`；gRPC server 默认注册 health、reflection、admin。
- 注册用生成函数：`v1.RegisterTodoServiceServer`、`v1.RegisterTodoServiceHTTPServer`。
- Client：`grpc.NewClient` 返回原生连接，`http.NewClient` 返回 `*http.Client`，再交给生成的 client 构造函数。常用 options：`WithEndpoint`、`WithDiscovery`、`WithMiddleware`、`WithTimeout`（默认 2s）、`WithTLSConfig`、`WithNodeFilter`、`WithSubset`；gRPC 另有 `WithStreamMiddleware`、`WithHealthCheck`；HTTP 另有 `WithBlock`（[grpc/client.go](https://github.com/go-kratos/kratos/blob/v3.0.0/transport/grpc/client.go#L36-L140)、[http/client.go](https://github.com/go-kratos/kratos/blob/v3.0.0/transport/http/client.go#L60-L162)）。
- `Transporter { Kind, Endpoint, Operation, RequestHeader, ReplyHeader }` 放在 context 里，server 端和 client 端用不同的 key（`FromServerContext` / `FromClientContext`），所以“处理请求时再发起下游调用”不会串（[transport.go L37–95](https://github.com/go-kratos/kratos/blob/v3.0.0/transport/transport.go#L37-L95)）。
- 版本差异：v2 的 `grpc.Dial` / `DialInsecure` 在 v3 只剩 `grpc.NewClient`（迁移指南没提）；v3 不再默认注册 `kratos.api.Metadata` 服务（[PR #3825](https://github.com/go-kratos/kratos/pull/3825)）。

### 9.6 Operation 命名与按操作挂中间件

- Operation 统一为 `/<package>.<Service>/<Method>`；生成代码同时导出 `OperationTodoServiceGetTodo`（HTTP）和 `TodoService_GetTodo_FullMethodName`（gRPC），两者值相同。
- gRPC 服务端直接用 `info.FullMethod`；HTTP 服务端先把 Operation 设为路由模板，生成的 handler 再覆盖成规范名（[http/server.go L280–289](https://github.com/go-kratos/kratos/blob/v3.0.0/transport/http/server.go#L280-L289)）。
- 两种按操作挂中间件的方式：
  - server 的 `Use(selector, ms...)`：`/*`、`/pkg.Service/*` 或完整名，按最长前缀匹配；
  - `selector.Server(ms...)` / `selector.Client(ms...)` 构建器：`Path`（精确）、`Prefix`、`Regex`（整串匹配）、`Match(func(ctx, operation) bool)`，`.Build()` 后是普通 middleware（[selector.go](https://github.com/go-kratos/kratos/blob/v3.0.0/middleware/selector/selector.go#L42-L106)）。
- 官方强调匹配的是 Operation，不是 HTTP 路径（[v2 文档](https://github.com/go-kratos/go-kratos.dev/blob/e0e143a/src/content/docs/zh-cn/docs/component/middleware/overview.md?plain=1#L198-L200)）。
- 典型用法是鉴权白名单；但官方 casbin 示例的白名单里是手写字符串，没有用生成的常量（[casbin http.go L25–37](https://github.com/go-kratos/examples/blob/61daed1/casbin/app/admin/internal/server/http.go#L25-L37)）。

### 9.7 错误模型

- `*errors.Error` = `Status{Code, Reason, Message, Metadata}` + 内部 `cause`。`Code` 用 HTTP 语义；`GRPCStatus()` 把它映射成 gRPC code，并把 reason 和 metadata 放进 `google.rpc.ErrorInfo`，两种协议都能还原（[errors.go L58–68](https://github.com/go-kratos/kratos/blob/v3.0.0/errors/errors.go#L58-L68)）。
- `errors.Is` 比较 code + reason；`FromError` 依次尝试 `errors.As`、从 gRPC status 还原、最后兜底 500；HTTP 服务端用 `Code` 作为状态码，HTTP 客户端把非 2xx 解回 `*errors.Error`。
- 推荐写法：proto 定义 `ErrorReason` 枚举；biz 声明包级错误变量 `errors.NotFound(v1.ErrorReason_TODO_NOT_FOUND.String(), "todo not found")`；data 把驱动错误映射成这些 biz 错误（[biz/todo.go](https://github.com/go-kratos/kratos-layout/blob/59ad406/internal/biz/todo.go#L16-L21)）。
- 设计理念：reason 是稳定可分支的标识，调用方不要判断 message；message 必须可以安全公开；metadata 不得包含 secret。
- HTTP/gRPC 状态映射是多对一的（例如 409 同时对应 Aborted 和 AlreadyExists）（[status.go](https://github.com/go-kratos/kratos/blob/v3.0.0/transport/http/status/status.go)）。

### 9.8 元信息传递

- `metadata.Metadata` 是 `map[string][]string`（key 小写），挂在 context 上；server 和 client 两端都装中间件才会跨网络。
- server 端默认只收 `x-md-` 前缀；client 端发出常量、显式设置的 client metadata，以及 server metadata 里 `x-md-global-` 前缀的值。`x-md-global-*` 逐跳透传，`x-md-local-*` 只在本服务可见；官方建议用 allowlist，追踪走 OTel（[metadata.go](https://github.com/go-kratos/kratos/blob/v3.0.0/middleware/metadata/metadata.go#L44-L110)、[元数据文档](https://go-kratos.dev/zh-cn/docs/component/metadata/)）。

### 9.9 App 与注册中心

- `kratos.New` 的 options：`ID`、`Name`、`Version`、`Metadata`、`Endpoint`、`Context`、`Logger`、`Server`、`Signal`、`Registrar`、`RegistrarTimeout`（默认 10s）、`StopTimeout`，以及 `BeforeStart`、`AfterStart`、`BeforeStop`、`AfterStop` 四个 hook。
- 生命周期：`Run` = 构造实例 → BeforeStart → 并发启动 server → 注册 → AfterStart → 等信号；`Stop` = BeforeStop → 注销 → 取消 context → 在 StopTimeout 内停止 server → AfterStop。
- `ServiceInstance.Endpoints` 是 URL 字符串列表（`grpc://ip:port`、`http://ip:port`），未显式指定时从实现了 `Endpointer` 的 server 自动收集（[app.go L176–199](https://github.com/go-kratos/kratos/blob/v3.0.0/app.go#L176-L199)、[registry.go L37–51](https://github.com/go-kratos/kratos/blob/v3.0.0/registry/registry.go#L37-L51)）。
- `discovery:///<Name>` 的 path 就是注册时的应用名；resolver 按本 transport 的 scheme 从实例 Endpoints 里挑地址，所以一个应用名下 HTTP 和 gRPC 可以共存（[internal/endpoint/endpoint.go](https://github.com/go-kratos/kratos/blob/v3.0.0/internal/endpoint/endpoint.go#L13-L24)）。
- 操作名用 proto 包名（`/user.service.v1.User/GetUser`），发现用应用名（`beer.user.service`），两个命名空间彼此独立。
- `kratos.FromContext(ctx)` 取 AppInfo。

### 9.10 不用 proto 时

- 可以用 `srv.Route(prefix)` 得到 Router（`GET/POST/…/Group`，handler 签名 `func(http.Context) error`），或用 `Handle/HandleFunc/HandlePrefix` 挂原生 handler。
- **手写路由不会自动执行 `http.Middleware` 注册的中间件链**，只经过 Filter；要复用中间件，必须手动 `http.SetOperation` + `ctx.Middleware(h)`，否则 Operation 只是路径模板（[router.go L45–59](https://github.com/go-kratos/kratos/blob/v3.0.0/transport/http/router.go#L45-L59)、[示例 handlers.go](https://github.com/go-kratos/examples/blob/61daed1/http/middlewares/handlers.go#L10-L26)、[#3670](https://github.com/go-kratos/kratos/issues/3670)）。
- 官方定位：proto 是服务契约，手写路由是文件上传、回调等场景的“逃生门”；没有官方的无 proto 类型化契约机制，v3 核心唯一的泛型 API 是 `config.Get[T]`。

### 9.11 设计理念与 AGENTS.md

- 工具箱 / “插座”：core 提供标准连接点，应用在边缘接入自己的实现。
- API 设计参考 Google API 指南与 AIP；要求版本化 package、保留字段号；HTTP path 也是公开 API；不兼容时新建 `v2` package（[v3 Protobuf 规范](https://go-kratos.dev/zh-cn/docs/guide/api-protobuf/)）。
- 中间件一种形态同时用于 HTTP 和 gRPC；核心不提供重试，重试与幂等由应用决定。
- 日志统一 `slog`，OTel 集成移到 contrib。
- kratos-layout 的 `AGENTS.md` 与 `CLAUDE.md` 内容相同，要点：DTO/DO/PO 三种模型和各层 import 方向；“A change crossing these arrows the wrong way is a layering bug”；新增资源的五步清单；测试边界；禁止手改生成文件；命名 `<Resource>Repo/Usecase/Service`、错误变量 `Err<Resource><Cause>`。

### 9.12 值得借鉴的范式

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
14. 生成物边界清晰，并把分层规则写进 AGENTS.md。

### 9.13 代价与被诟病之处

1. 手写路由是二等公民：不自动执行中间件，Operation 退化成路径模板，白名单只能手写字符串（[#3670](https://github.com/go-kratos/kratos/issues/3670)）。
2. 错误模型与“统一响应包装、200 + 业务码”的需求冲突，又会碰上 protojson 零值省略（[#1281](https://github.com/go-kratos/kratos/issues/1281)、[#1952](https://github.com/go-kratos/kratos/issues/1952)、[#1539](https://github.com/go-kratos/kratos/issues/1539)）。
3. 状态映射多对一，gRPC 原生 code 不能完整往返。
4. proto 工具链 + 分层样板偏重（buf 插件、生成物入库、每层 ProviderSet 和 Wire、DTO/DO/PO 三次转换）。
5. 中间件按 server 分别配置，两端容易不一致（模板的 validate 只装在 HTTP 上）。
6. v3 生态和文档仍在追赶：examples 与 beer-shop 停在 v2；contrib 子模块缺 tag（[#3846](https://github.com/go-kratos/kratos/issues/3846)）；若干文档漂移。
7. 不安全默认值：未匹配路由回落到 `http.DefaultServeMux`（[#3810](https://github.com/go-kratos/kratos/issues/3810)，NOT_PLANNED）；继续使用已归档的 gorilla/mux（[#2912](https://github.com/go-kratos/kratos/issues/2912)）。

---

## 10. 调研：go-micro v6

出处约定：不带前缀的路径相对于 [`micro/go-micro@9e5c1dd`](https://github.com/micro/go-micro/tree/9e5c1dde6bf243027c1cec352612bf72eaf35048)（2026-09-26 的 master），`#L` 后是行号；`@v4.11.1:` 这类前缀表示对应 tag；其他仓库写成 `go-micro/demo:路径`。

### 10.1 现状与版本

- 最新 **v6.14.0**（2026-09-21），模块路径 `go-micro.dev/v6`，仓库 `micro/go-micro`（`asim/go-micro` 重定向至此），Apache-2.0，Go 1.25。文档站 https://go-micro.dev 在线；示例在主仓库 `examples/`；`micro/examples`、`micro/micro` 两个仓库已 404。
- 模块路径历史：v1 `github.com/micro/go-micro`（2019-03）→ v2 `…/v2`（2020-01）→ v3 `github.com/asim/go-micro/v3`（2021-01）→ v4 `go-micro.dev/v4`（2021-10）→ v5 `go-micro.dev/v5`（2024-06）→ v6 `go-micro.dev/v6`（2026-06）；v4.11.1 维护版发布于 2026-09-10。
- v6 的重心转向 `NewAgent`、`NewFlow` 和 MCP/A2A 网关；服务侧新增 `NewGroup`（多服务同进程）、`client.Local()`（v6.8）、`EndpointOptions` / `DiscoveryError` / `WaitForService`（v6.14）。
- `micro.NewService(name, opts...)` 是服务构造函数，旧的无名写法已删除（`CHANGELOG.md#L381-383`）。
- proto 可选：2026-06-22 起 `micro new` 默认不生成 proto，需要时加 `--proto`（PR #2986）。
- 维护风险：2024-07 作者公开寻找新 owner（[#2723](https://github.com/micro/go-micro/issues/2723)）；2026 年起由自动化 “loop” 合并代码并发版（`CHANGELOG.md#L8`）；2026-09 开了许可与商业模式 RFC（[#4912](https://github.com/micro/go-micro/issues/4912)）。2020 年 v3 曾改名 Nitro 并换成非商业许可（[#2077](https://github.com/micro/go-micro/issues/2077)、[#2086](https://github.com/micro/go-micro/issues/2086)）。

### 10.2 服务定义与 handler 注册

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

### 10.3 Client 范式

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

### 10.4 protoc-gen-micro 生成代码

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

### 10.5 注册中心与选择器

- Registry 接口：`Register`、`Deregister`、`GetService`、`ListServices`、`Watch`；默认 mDNS。
- 结构：`Service{Name, Version, Metadata, Endpoints, Nodes}`、`Endpoint{Request, Response *Value, Metadata, Name}`、`Value{Name, Type, Values}`（`registry/registry.go#L31-57`）。
- server 启动时注册，每 30s 续约，TTL 90s；`Node.Metadata` 自动写入 transport、broker、server、registry、`protocol=mucp`（`server/rpc_server.go#L416-429,683`、`server/server.go#L147-148`）。
- selector：从带缓存的注册中心取服务 → 依次过滤（`FilterEndpoint`、`FilterVersion`、`FilterLabel`）→ 策略（默认 `Random`，可换 `RoundRobin`）→ 返回 `Next()`；过滤器要调用方通过 `WithSelectOption` 传入；默认 selector 的 `Mark` / `Reset` 是空函数（`selector/default.go#L64-87,106`）。
- v6 里注册中心同时是 MCP、A2A 和 agent 工具发现的唯一数据来源，`registry.Endpoint` 被转成工具 schema（`model/tools.go#L101-128`）。

### 10.6 中间件（wrapper）

- `server.HandlerWrapper`（`func(HandlerFunc) HandlerFunc`）、`server.SubscriberWrapper`、`client.Wrapper`（`func(Client) Client`，通常内嵌后只覆盖 `Call`）、`client.CallWrapper`（包住对某个节点的单次尝试，处在重试循环里层）。
- 通过 `micro.WrapHandler/WrapSubscriber/WrapClient/WrapCall` 注入（`service/options.go#L283-314`），先注册的在最外层。
- `server.Request` 提供 `Service()`、`Method()`、`Endpoint()`、`Header()`、`Body()`（已解码）。
- 按 endpoint 区别对待靠在 wrapper 里比较 `req.Endpoint()`，例如 auth wrapper 的 `SkipEndpoints: []string{"Health.Check"}`（`wrapper/auth/server.go#L41-48`）；OTel wrapper 的 span 名是 `service.endpoint`（`wrapper/trace/opentelemetry/wrapper.go#L114-131`）。

### 10.7 错误模型

- `errors.Error{Id, Code, Detail, Status}`，v6.14 加 `Reason`、`Domain`；`Code` 用 HTTP 状态码，`Status` 由 `http.StatusText` 自动填；`Id` 一般写服务名或 endpoint 名。
- 构造函数 `BadRequest`、`NotFound`、`Timeout`、`InternalServerError` 等；v6.14 新增 `AlreadyExists`、`FailedPrecondition`、`ResourceExhausted`、`Unavailable`。
- 线上格式是 `json.Marshal` 后的字符串，mucp 协议下放在 `Micro-Error` 请求头；client 拿到字符串类型的 `serverError`，要用 `errors.FromError` 还原；handler 返回普通 `fmt.Errorf` 会丢状态码（`errors/errors.go#L14-38,186`、`client/rpc_codec.go#L26`）。
- `Is` 主要比较 Code，Reason/Domain 可选。

### 10.8 元信息

- `metadata.Metadata` 是 ctx 里的 `map[string]string`；`FromContext` 返回副本。
- server 端复制全部请求头，加上 `Local`/`Remote`；`Timeout` 请求头（纳秒）变成 ctx 截止时间（`server/rpc_server.go#L243-258`）。
- client 端把 ctx 里的 metadata 全部复制到请求头（只跳过 `Micro-Topic`），再写入 `Timeout`（`client/rpc_client.go#L99-123`）。**没有白名单，全部往下传。**

### 10.9 发布订阅

- 发布：`micro.NewEvent(topic, client).Publish(ctx, msg)`；订阅：`micro.RegisterSubscriber(topic, server, h, opts...)`，`h` 可以是函数或 struct；消息类型由参数类型决定。
- 订阅者也作为 endpoint 发布到注册中心（名字 `Func` 或 `Struct.Method`，元数据带 `topic`、`subscriber=true`）；`SubscriberQueue` 实现竞争消费，`DisableAutoAck` 关闭自动确认（`server/subscriber.go#L58-62,86`）。
- topic 没有命名规范；v6 的 pubsub 模板改为直接调用 `broker.Publish/Subscribe`，事件编排交给 `NewFlow`。

### 10.10 项目模板与多服务示例

- v6 `micro new foo` 默认生成 `main.go`、`handler/foo.go`、`Makefile`、`README.md`、`.gitignore`、`go.mod`，并挂上 `mcp.WithMCP(":3001")`；加 `--proto` 或用 crud/pubsub/api 模板时生成 `proto/foo.proto`（`cmd/micro/cli/new/new.go#L210-212`）。
- v4 时代 `go-micro new service foo`（独立仓库 go-micro/cli，已归档）生成 `main.go`、`handler/`、`proto/`、`Makefile`、`Dockerfile`；开发流程 `make proto tidy` → `go-micro run` → `go-micro call helloworld Helloworld.Call '{...}'`。
- 跨服务调用的真实示例在 go-micro/demo（Online Boutique 移植版），见 10.3；v6 主仓库示例里没有 handler 调用另一个服务的例子。

### 10.11 API 网关映射与历史命名空间

- v1–v4 的 `micro api` 默认命名空间 `go.micro.api`：`/greeter/say/hello` → 服务 `go.micro.api.greeter` 的 `Say.Hello`；`/foo/bar` → `Foo.Bar`（`@v1.18.0:api/resolver/micro/route.go#L14-15`）。
- 当年的命名习惯：后端 `go.micro.srv.X`、HTTP 聚合层 `go.micro.api.X`、web `go.micro.web.X`；网关 handler 类型 `api`、`rpc`、`http`、`web`、`event`。
- v6 去掉命名空间，服务名就是 `NewService` 传入的名字；`micro run` 自带网关规则 `/api/{service}/{Handler.Method}`（`cmd/micro/gateway/server.go#L922-923,964`）。

### 10.12 设计理念

- “sane defaults with a pluggable architecture”：所有抽象都是 Go interface，插件与核心同仓（ADR-001）；配置按“零配置 → 环境变量 → 代码选项”逐级加码（ADR-009）。
- 自我定位 “Batteries included”，适合 “conventions over decisions” 的团队（`guides/comparison.md#L31,44`）。
- 反射是有意为之：社区提议用泛型取代反射（[#2782](https://github.com/micro/go-micro/issues/2782)，2026-02-03 关闭），评估文档结论为保留反射（`internal/website/content/en/docs/REFLECTION-EVALUATION-SUMMARY.md#L100,121`；该文档署名 GitHub Copilot，性能数字自称 Hypothetical）。
- 2026 年的新说法：服务是 “named, network-addressable, typed, independently deployable unit”，“A registration is a tool definition”；“怎么创建服务”应该只有 “exactly one answer”（`the-evolution-of-microservices.md#L52,62`、`developer-experience-cleanup-one-way-to-do-things.md#L93,107`）。
- 作者回顾：v2 拿了风投，“framework and company were like oil and water”；v3 做成 PaaS，“too opinionated”；v4/v5 回到开发者框架；v6 “leads with agents... not a rewrite”（`bringing-an-open-source-project-back-from-the-dead.md#L20-50`）。

### 10.13 值得借鉴的范式

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

### 10.14 代价与被诟病之处

1. 反射魔法导致错误被悄悄吞掉：签名写错的方法只打日志就跳过，要到调用时才发现；去反射的诉求被拒。
2. endpoint 是字符串，还跟 Go 类型名绑在一起：不用代码生成时要手写 `"Say.Hello"`；struct 改名，线上契约就断了。
3. response 是出参，类型系统帮不上忙；普通方法和流式方法签名不一致。
4. 注册中心里的 schema 信息很少（只记类型名、最多 3 层、无必填和枚举），MCP 网关只好再解析一遍 struct tag。
5. 默认协议下错误是请求头里的一段 JSON 字符串，普通 error 会丢状态码。
6. 隐藏的全局状态和选项顺序陷阱（`Init` 改写全局 store、换 gRPC server 后名字丢失、默认 selector 的 `Mark` 是空函数等）。
7. metadata 没有白名单，token 和内部请求头会顺着调用链扩散。
8. 生态和 API 不稳定：模块路径换了五次，经历过改名和许可波折，示例仓库被删，推荐写法短期内反复。

---

## 11. 两家对比、共识与教训

### 11.1 对比

|                | go-kratos v3                                                  | go-micro v6                                                            | LikeGo（拟议）                                                            |
| -------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 契约从哪来     | `api/<领域>/<版本>/` 下的 proto，生成 gRPC/HTTP 绑定          | 默认反射：struct 的方法就是 endpoint；proto 生成可选                   | `api/<svc>/v1` 下的 TS 模块：`service(...)` + `endpoint(...)`，不需要生成 |
| 操作名         | `/todo.v1.TodoService/GetTodo`，以生成常量导出                | `Greeter.Hello`（类型名.方法名）                                       | `payments.v1/pay`，由 endpoint 对象承载                                   |
| 发现名         | 应用名，`discovery:///beer.user.service`                      | 构造客户端时传入：`NewGreeterService(name, c)`                         | `newClient(withService("payments-http"), …)`                              |
| 实现签名       | `(ctx, *Req) (*Reply, error)`                                 | `(ctx, *Req, *Rsp) error`，响应是出参                                  | `(ctx, request) => response`                                              |
| 注册           | `v1.RegisterTodoServiceServer(srv, impl)`                     | `service.Handle(h)`，或 `RegisterGreeterHandler(s, h)`                 | `registerService(server, payments, impl)`                                 |
| 调用           | `v1.NewTodoServiceClient(conn).GetTodo(ctx, req)`             | `pb.NewGreeterService("greeter", c).Hello(ctx, req)`                   | `client.call(ctx, payments.pay, req)`                                     |
| 按操作挂中间件 | `selector.Server(mw).Prefix(...)`、`srv.Use(pattern, mw)`     | wrapper 里比较 `req.Endpoint()`；`EndpointOptions["service/Endpoint"]` | 拟议 `use(payments, mw)`、`use(payments.refund, mw)`（第三段定）          |
| 错误           | `{code, reason, message, metadata}`，reason 可在 proto 里声明 | `{id, code, detail, status, reason, domain}`                           | 现有 `ServiceError {code, message, status, metadata}`；契约内声明待定     |

### 11.2 两家的共识（LikeGo 已经做到）

- 契约里的服务身份和部署用的发现名是两回事。
- 线上名字由契约决定，不由实现类决定。
- 一份实现可以注册到多个 server。
- handler 用返回值（kratos）；go-micro 的出参写法沿袭自 `net/rpc`。

### 11.3 两家的教训（LikeGo 要避开）

- kratos 生成了操作名常量，大家还是在手写字符串；手写 HTTP 路由不经过中间件链，操作名退化成路径模板。
- go-micro 遇到签名写错的方法只打日志就跳过，要等调用时才发现。
- go-micro 的 endpoint 名跟着 Go 类型名走，struct 一改名，线上契约就断了。
- go-micro 的 metadata 全量透传；kratos 用前缀和 allowlist 控制传播。

### 11.4 旁支发现（不在本次范围）

- kratos 在一个应用名下同时注册 `grpc://` 和 `http://` 地址，客户端按自己的协议挑选；LikeGo 现在 HTTP 和 gRPC 各用一个发现名（`orders-http`、`orders-grpc`）。

---

## 12. 附录 A：side chat 还原记录

- 父会话：`codex://threads/01a0dcdd-c971-7df1-80df-1de3869f962e`（分析分支设计与开发体验）
- side chat 线程：`01a0dfd7-77f8-75c0-ae73-c7179be184e8`（临时线程，未落盘）
- 时间：2026-09-27 06:32–07:36（本地时间），10:37 空闲过期被回收
- 用户输入取自 `~/.codex/logs_2.sqlite`（9 轮完整）；助手回复取自 Codex 窗口界面（只渲染了第 7–9 轮，第 1–6 轮未能还原）

### 第 1 轮 06:32（用户）

从父会话选中了：

```ts
export const quote = endpoint("payments", "Quote", QuoteRequest, QuoteResponse)
```

> 我有个想法，我看见过一种库，是可以直接一次性定义好 client、server 的 handle，然后 export 让各个模块 import 即可，这样就不需要手动写 server name 和 call name 了，而且类型还是强类型

（助手回复未还原）

### 第 2 轮 06:49（用户）

> 我希望定义的不是 defineService 嗷

（助手回复未还原）

### 第 3 轮 07:07（用户，发出 9 秒后中断，重发为第 4 轮）

> 我感觉我并不是要 callQuote、registerQuote，而是类似以下的样子（附带了 `endpoint("pay", PayRequest, PayResponse)` 与对象形式两种写法）

### 第 4 轮 07:07（用户）

> 我感觉我并不是要 callQuote、registerQuote，而是类似以下的样子

```ts
export const payHandle = endpoint({
  name: 'pay',
  request: PayRequest,
  response: PayResponse,
  handle: (ctx, request) => {
    return xxx
  }
})
// client
client.call(ctx, payHandle, {...})
// server
registerService('payments', payHandle)
```

（助手回复未还原）

### 第 5 轮 07:13（用户）

> 不需要写service 名字吧？Handle本意只是定义调用函数而已

（助手回复未还原）

### 第 6 轮 07:19（用户，33 秒后中断，随即补充第 7 轮）

> 那么 endpoint 可以叫做 defineHandle，然后 defineHandle可以 defineHandle('pay', {...})
>
> 本质就是定义 handle，和普通的 http 框架一样，但是在我们微服务中，client 可以使用 import 这个 handle，就可以获取到强类型的 request、response、handle name，用于调用

### 第 7 轮 07:20（用户）

> 类似于现代 js 的 web 框架的 "End-to-End" 设计一样

#### 助手 07:21

对，这就是更准确的方向：现代 JS Web 框架式的 End-to-End Handle，而不是 `defineService`。

推荐公开 API：

```ts
export const pay = defineHandle("pay", {
  request: PayRequest,
  response: PayResponse,

  handle: async (ctx, request) => {
    return {
      paymentId: request.paymentId,
      status: "success"
    }
  }
})
```

客户端直接 import 同一个 handle：

```ts
const client = newClient(/* 已绑定 payments 服务 */)

const result = await client.call(ctx, pay, {
  paymentId: "p-001"
})
```

服务端直接注册同一个 handle：

```ts
registerService(server, "payments", pay)
```

`defineHandle` 产生的对象同时包含：

```ts
interface Handle<Request extends Struct, Response extends Struct> {
  readonly name: string
  readonly request: Request
  readonly response: Response
  readonly handle: TypedHandler<Request, Response>
}
```

因此 `client.call` 可以自动推导：

```ts
client.call(ctx, pay, request)
// request: Infer<typeof PayRequest>
// Promise<Infer<typeof PayResponse>>
```

`registerService` 则只负责把它绑定到服务：

```ts
function registerService(
  server: HandlerRegistrar,
  serviceName: string,
  handle: Handle<Struct, Struct>
): void {
  server.registerHandler(serviceName, handle.name, handle.handle)
}
```

这里的分层很清楚：

```text
defineHandle("pay", ...)
        │
        ├── Client：读取 name/request/response
        └── Server：读取 name/request/response/handle

registerService(..., "payments", ...)
        │
        └── 把 pay 绑定到 payments 服务
```

service 不属于 Handle，因为 Handle 表示的是“调用哪个业务操作”，而不是“部署在哪个服务”。服务名属于 Client/Server 的绑定阶段。

这个设计有几个重要特点：

- 没有 `callPay`；
- 没有 `registerPay`；
- 没有重复写 `"pay"`；
- 没有手写 client/server 类型；
- request、response、handler 始终来自同一份定义；
- Transport 可以替换成 HTTP、Memory 或其他内部实现；
- `httpRoute` 仍然可以把外部 `/v1/pay` 映射到同一个 Handle。

所以公共 API 应该从：

```ts
endpoint(...)
client.call(ctx, endpoint, request)
server.registerHandler(...)
```

收敛为：

```ts
defineHandle(...)
client.call(ctx, handle, request)
registerService(server, serviceName, handle)
```

`Endpoint` 可以继续作为内部实现概念，但用户文档的主词汇应该改成 Handle。这才是真正的 End-to-End 类型契约。

### 第 8 轮 07:24（用户）

> registerService 其实可以设计为 registerService(server, name, {pay, login, getUser})
>
> 在 client，甚至不需要 export handle，直接 export service

#### 助手 07:26

对，这样就完整了：不需要 `defineService`，Service 本身就是一组 Handle 的普通对象。

推荐写成：

```ts
// payments.ts
export const payments = {
  pay: defineHandle({
    request: PayRequest,
    response: PayResponse,

    handle: async (ctx, request) => {
      return {
        paymentId: request.paymentId,
        status: "success"
      }
    }
  }),

  login: defineHandle({
    request: LoginRequest,
    response: LoginResponse,

    handle: async (ctx, request) => {
      // ...
    }
  }),

  getUser: defineHandle({
    request: GetUserRequest,
    response: UserResponse,

    handle: async (ctx, request) => {
      // ...
    }
  })
} as const
```

此时 `pay`、`login`、`getUser` 的对象 key 就是调用名，因此 `defineHandle` 甚至不需要再接收 name。

服务端：

```ts
registerService(server, "payments", payments)
```

内部等价于：

```ts
server.registerHandler("payments", "pay", payments.pay.handle)
server.registerHandler("payments", "login", payments.login.handle)
server.registerHandler("payments", "getUser", payments.getUser.handle)
```

客户端不需要单独导出每个 Handle，可以绑定整个 Service：

```ts
const paymentsClient = client.bind("payments", payments)

await paymentsClient.pay(ctx, {
  paymentId: "p-001"
})

await paymentsClient.getUser(ctx, {
  userId: "u-001"
})
```

类型可以自动映射：

```ts
type ServiceClient<S extends ServiceDefinition> = {
  [K in keyof S]: (
    ctx: Context,
    request: Infer<S[K]["request"]>
  ) => Promise<Infer<S[K]["response"]>>
}
```

这样业务代码只需要维护一份：`payments.pay`、`payments.login`、`payments.getUser`。它同时提供：服务端 handler、endpoint 名称、request schema、response schema、客户端调用类型、服务端注册信息。

最终心智模型：

```text
Service object
  ├── pay
  ├── login
  └── getUser

registerService(server, "payments", service)
client.bind("payments", service)
```

`"payments"` 只在服务绑定阶段出现一次；每个 Handle 只关心自己的业务操作。

如果需要保留底层能力，仍然可以支持 `client.call(ctx, payments.pay, request)`，但它应该是 advanced API。普通用户使用 `paymentsClient.pay(ctx, request)`。

这就是比较完整的 End-to-End 设计：Service 是普通导出的契约对象，Handle 是其中的操作定义，Client 和 Server 都从同一份 Service 推导。

唯一需要后续确认的是客户端 bundle：如果浏览器直接 import 这个 Service 对象，可能会把服务端 handle 实现一起打包。Node 微服务场景可以先接受；浏览器或第三方 SDK 场景再提供 contract-only 的客户端入口。

### 第 9 轮 07:29（用户，回复批注）

批注对象（第 8 轮助手回复中的一行）：

```ts
const paymentsClient = client.bind("payments", payments)
```

> 不要这种所谓的 bind。请你联网调样别人的 End to End 设计理念，然后才能打造我们独有的方案

#### 助手 07:36（最终回复，联网调研 7 分钟）

对，`bind` 应该删掉。它把“服务契约”和“运行时客户端”又拆成了一层，与你想要的 End-to-End 体验相反。

我查了几种主流设计后，发现它们主要有三种思路：

- tRPC：服务端定义 router/procedure，客户端像调用本地函数一样调用 `client.getUser.query(...)`；客户端通常只导出 Router 类型，避免把服务端实现打进客户端。
- Hono RPC / Elysia Eden：服务端路由本身形成一棵可推导的 API 树，客户端镜像这棵树，例如 `client.posts.$post(...)` 或 `app.hi.get()`。
- ts-rest / oRPC：导出共享 contract/router，客户端和服务端分别消费同一份结构；oRPC 直接支持把普通对象作为 procedure router，并生成镜像客户端。

LikeGo 最适合做一个混合模型：Service 是普通导出的对象，Handle 是对象里的业务操作；Server 注册整个对象，Client 直接使用对象里的 Handle。

```ts
// payments.ts
export const payments = {
  pay: defineHandle("pay", {
    request: PayRequest,
    response: PayResponse,

    handle: async (ctx, request) => {
      return {
        paymentId: request.paymentId,
        status: "success"
      }
    }
  }),

  login: defineHandle("login", {
    request: LoginRequest,
    response: LoginResponse,

    handle: async (ctx, request) => {
      // ...
    }
  }),

  getUser: defineHandle("getUser", {
    request: GetUserRequest,
    response: UserResponse,

    handle: async (ctx, request) => {
      // ...
    }
  })
} as const
```

服务端：

```ts
registerService(server, "payments", payments)
```

内部相当于：

```ts
for (const handle of Object.values(payments)) {
  server.registerHandler("payments", handle.name, handle.handle)
}
```

客户端不需要单独导出 `payHandle`：

```ts
import { payments } from "./payments"

const result = await client.call(ctx, payments.pay, {
  paymentId: "p-001"
})
```

这里：

- `payments` 是唯一共享导出；
- `payments.pay` 是强类型 Handle；
- `payments.pay.name` 是 `"pay"`；
- `payments.pay.request` 推导请求类型；
- `payments.pay.response` 推导响应类型；
- `payments.pay.handle` 只在服务端注册阶段使用。

所以最终的用户心智是：

```text
payments.pay
payments.login
payments.getUser
```

而不是：

```text
callPay
registerPay
newPaymentsClient
client.bind(...)
server.registerHandler(...)
```

`defineHandle("pay", ...)` 中的 `"pay"` 仍然需要定义一次，因为它是跨服务路由和 observability 的稳定操作名；但它不会在 Client、Server 或调用代码中重复出现。

我建议把这定为 LikeGo 的独有方案：

```ts
defineHandle(name, {
  request,
  response,
  handle
})
```

配合：

```ts
registerService(server, serviceName, service)
client.call(ctx, service.handle, request)
```

这比单纯复制 tRPC router 更适合 LikeGo，因为：

- Handle 是独立的一等值；
- `Context` 仍然是 handler 的显式首参；
- Struct schema 在运行时校验请求和响应；
- HTTP、Memory、gRPC adapter 可以复用同一套业务 Handle；
- Service 只是 Handle 的导出集合，不需要额外的 `defineService` DSL；
- 低层 `client.call` 保留，普通用户只需要 import service 对象。

唯一需要单独处理的是浏览器 bundle：如果客户端运行在浏览器，不应把包含真实 `handle` 实现的服务对象直接打包进去。tRPC 和 oRPC 都通过“只导出 Router/Contract 类型或裁剪后的 contract”解决这个问题；LikeGo 后续也可以提供 client-only contract projection，但这不影响当前 Node 微服务的核心设计。

---

## 13. 附录 B：流程状态与恢复步骤

brainstorming 检查表：

| 步骤                                                                     | 状态                                        |
| ------------------------------------------------------------------------ | ------------------------------------------- |
| 摸清上下文（kratos 目录结构、LikeGo 现有 client/server/protoc-gen-like） | 完成                                        |
| 逐个澄清问题                                                             | 完成（对外定义层只放契约；沿用 `endpoint`） |
| 给出方案与推荐                                                           | 完成（命名方案 A）                          |
| 调研 go-kratos / go-micro 范式                                           | 完成，结论已接受                            |
| 分段呈现设计：第一段 对外定义层                                          | 已确认                                      |
| 分段呈现设计：第二段 服务端实现与注册                                    | 已确认（调研后维持）                        |
| 分段呈现设计：第三段 范围与迁移                                          | **下一步**                                  |
| 分段呈现设计：第四段 错误处理与测试                                      | 待呈现                                      |
| 写正式 spec（默认 `docs/superpowers/specs/`）并提交                      | 待做                                        |
| spec 自查（占位符、矛盾、歧义、范围）                                    | 待做                                        |
| 用户审阅 spec                                                            | 待做                                        |
| 转入 writing-plans 写实施计划                                            | 待做                                        |

在新会话里接着做时：

1. 先读本文第 0、2、6 节，确认决策和待定事项。
2. 从 6.1 开始呈现第三段「范围与迁移」，逐项请用户确认；确认后把结论补进本文第 2 节，并更新附录 B。
3. 再呈现第四段（6.2），确认后同样补进本文。
4. 写正式 spec、自查、请用户审阅，然后转 writing-plans。
5. 沟通用中文；每次只问一个问题；不要重新提出第 2 节列出的被否决方案。
