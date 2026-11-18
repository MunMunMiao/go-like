# 决策记录（2026-11）

这 52 条决定（D1-D52）使五份领域设计与观测设计相互一致，是约束性记录：任何设计文档与本记录不一致时，以本记录为准；本记录未涉及之处以所属领域设计为准，这些设计的内容由[总设计](README.md)整理（文档优先级见总设计第 0.3 节）。凡决定依赖待维护者确认的问题（OQ1-OQ14），按[总设计](README.md)第 12 章与本文末尾表格中的推荐默认值书写，并在该条标注“待确认”。设计稿中的 API 不代表当前公共接口。

约定：

- 路径相对于仓库根目录。**已验证**指在引用文本中读到，或由命令复现；**推断**指经推理而未执行。
- 观测的派生规则 R1-R7 与 R4b 定义于[总设计](README.md)第 5.3 节。
- 每条决定的格式为：问题、决定、理由；仅当依据引用了仓库文件时附证据，仅当依赖待确认问题时附待确认。

## A 生命周期与内核

### D1 `Server` 与 `Endpointer` 移入 `@go-like/core/lifecycle`

- **问题：** 根入口同时导出 `Server`、`Endpointer`，使插座子路径不得不导入根入口；集成检查为此产生 18 条类型诊断。
- **决定：**
  - 设立 `./lifecycle`，导出 `Server`、`Endpointer`、`newResourceServer`、`ResourceServerOptions` 与 `ResourceServerError`；根入口不再导出 `Server`、`Endpointer`。
  - 所有使用者统一写 `import type { Server } from "@go-like/core/lifecycle"`：`/broker`、`/job`、redis、bullmq、file、`connectrpc/node` 与各使用示例。
  - pino 与 winston 插头完全不再导入 `Server`：它们实现的是 `TelemetryLifecycle`，不是 `Server`；原先“原样迁移”的 `types.ts` 因此删去该行。
- **理由：** 这是唯一使任何插座子路径都不导入根入口的布局；先前方案只把“导入根入口”作为权宜之计。集成声明树中的对应补丁在两种编译器上消除了全部 18 条诊断，根入口的导入者从 3 个降到 1 个（`./node`，设计如此）。

### D2 选项名为 `resources(...)`

- **问题：** 资源层选项最初叫 `resource(...)`，与示例中已有的标识符冲突。
- **决定：** 选项为 `resources(...values)`；数据领域设计中所有 `resource(...)` 一并改名。
- **理由：** 单数名与实测标识符相撞，且集成检查中有 3 条相关诊断；改名后诊断消失。
- **证据：** `examples/enterprise-platform-runtime/src/main.ts:82`（`const resource = resourceFromAttributes(...)`）。

### D3 资源层等待准入，观测层与服务器层保持发起规则

- **问题：** 内核最初只保证资源“先发起”，把挂起的 `start` 视为与缓慢的准入无法区分。这使数据领域的旗舰示例在启动时失败：`resources(queue) + server(queue.worker())` 下，worker 在队列就绪之前启动并以 `JobStateError` 失败。
- **决定：**
  - **契约：** `resources(...)` 的参与者是结构化 `Server`，其 `start(ctx)` 在资源被接纳并可用时 resolve，接纳失败时 reject；不得在运行期间一直挂起，长期运行的参与者属于 `server(...)`。
  - **内核：** 资源在 `beforeStart` 钩子之后、任何服务器之前，按声明顺序逐个启动，并以 `waitForContext(startContext, enterRoot(resourceContext, () => resource.start(resourceContext)))` 等待。资源收到的 `resourceContext` 存活到资源层停止；App 的等待受 `startContext` 约束，后者在停止请求、父 Context 取消或 `startTimeout` 到期时结束，因此 `startTimeout` 的作用范围扩展到资源层。
  - **回滚：** 被拒绝的准入以 `start_failed` 使启动阶段失败，资源 _i-1 … 0_ 逆序停止；`startContext` 结束时仍在等待准入的资源也会收到 `stop(stopContext)`，与已发起服务器的现行规则相同。停止顺序、共享的 `stopTimeout` 预算、在所有服务器启动结算之后逆序停止，均保持不变。
  - **`newResourceServer`：** `start` 在 `open` 之后 resolve（没有 `open` 时立即 resolve）；`terminal` 登记在 core 私有的 `WeakMap` 中，内核在准入后读取。在停止请求之前结算的终态是 `tier: "resource"` 的参与者失败（见 D8）：带 `Error` 值或 reject 时携带该错误，干净 resolve 时为 `GO_LIKE_RESOURCE_CLOSED`。ADR 0003 的排空规则保持不变，唯一改变的是“`start` 挂起到排空”一项，改为“终态经私有通道监视”。不新增公开的插座成员：不经 `newResourceServer` 手写的资源没有早期终态报告；需要它的资源组合使用 `newResourceServer`，插头也可以，因为它是公开的 core 函数。
  - **其他层：** 观测层与服务器层保持“发起加即时失败检查”，其参与者可以在运行期间挂起。
- **理由：**
  - 设计准则要求资源层“在服务器之前启动、之后停止”；五个现有使用者需要的是*启动*顺序，例如缓存必须先连上，Web 服务器才接收流量。
  - 资源层有了自己的契约、且 core 私下监视 `newResourceServer` 的终态之后，“挂起的 `start` 与缓慢的准入无法区分”这一反对理由即不再成立。
  - 沿用发起规则则要求每个数据插头各自提供就绪探针、让 batch-reporting 在 `afterStart` 中等待，并且会让请求到达仍在连接的 Redis 缓存。
  - 已验证：在基于 Bun 1.4.4 的资源层模型上，5 个用例通过。发起规则下该组合以 `JobStateError` 失败；等待准入下 worker 在队列之后启动、在队列之前停止；`newResourceServer` 的终态使 App 失败；`startTimeout` 约束挂起的准入，且该资源仍会收到 `stop`；准入期间的停止请求结束 `run()`。
- **证据：** 服务器层现行的发起加即时失败检查位于 `packages/core/src/app.ts:746-766`。本决定修订 ADR 0006 的相关表述，即所有者清理是 `stop` 的承诺而非 `start` 的承诺（`research/adr/0006-store-contract-and-providers.md:76-77`），详见[总设计](README.md)第 6.5 节。
- **已确认：** OQ2（2026-11-16）。

### D4 `newResourceServer` 是接入应用自有原生资源的唯一适配器

- **问题：** 数据领域设计原先为 NATS 连接单独写了 `natsConnectionResource`，与 `newResourceServer` 形成两条路径。
- **决定：** 以 `newResourceServer({ terminal: connection.closed(), close: () => connection.drain() })` 取代 `natsConnectionResource`；batch-reporting 与 payments-ledger 同样使用它。
- **理由：** 只保留一条规范路径；该辅助函数一次性承载 ADR 0003 的单次排空与早期终态规则，而内联适配器两者都没有。
- **证据：** `research/comparisons/developer-experience.md:29`（一条规范路径）。

### D5 Config 留在层之外，钩子留在资源层之外

- **问题：** `Config` 的 `load`/`close` 与钩子、资源层之间的关系需要定论：配置是否进入资源层，钩子能否依赖已启动的资源。
- **决定：**
  - `Config` 保持 `load`/`close`；为服务器提供配置的值在 `newApp` 之前加载（D10 的引导模式）。
  - 不为任何服务器提供配置的 Config 可以加入资源层，文档给出配方：`resources(newResourceServer({ open: (ctx) => config.load(ctx), close: (ctx) => config.close(ctx) }))`。因 `open` 被等待，该配方符合 D3。
  - `beforeStart` 在资源之前运行，`afterStop` 在资源之后运行。
- **理由：** 目前没有任何钩子需要已启动的资源；需要时用 `afterStart` 或资源自己的 `open`。该配方不增加 API。

### D6 单一的重复 core 检测器，在模块求值时执行

- **问题：** 先前存在两个写同一全局槽的检测器，经验证在 Node 与 Bun 上互不兼容（阻塞项）。
- **决定：**
  - 保留内核设计的检测器：每个拥有品牌的模块使用 `coreInstance`，把 `{ version, url }` 写入 realm 槽 `globalThis[Symbol.for("go-like.core.instances")]`。
  - `url` 或 `version` 不同即抛出 `name: "CoreInstanceError"`、`code: "GO_LIKE_CORE_DUPLICATE_INSTANCE"` 的 `Error`。
  - 删除 `assertSingleCore()`、`newApp`/`newTelemetry` 中的调用，以及导出的 `CoreDuplicateInstanceError`。
  - `Symbol.for` 键只是检测器的会合点，从不用于判断身份，因此设计准则对 `Symbol.for` 品牌的禁令得到遵守；OTel 使用同类的槽。不设关闭开关（目前没有使用者）。
  - Bun 下无提示的单副本版本偏差，靠锁步发布、npm 的 ERESOLVE 与文档来接受。
- **理由：** 它覆盖从不调用 `newApp` 的脚本；它能检测同版本的第二条路径，补上另一方案自己承认的缺口；在求值时抛出的错误无处可分支，所以导出错误类型没有使用者。已在 Bun 与 Node 上做过验证，并复现了两个写入者互相冲突的情形。
- **待确认：** OQ14（检测器键与无关闭开关）；OQ5（Bun 偏差）。

### D7 就绪与 `/healthz`

- **问题：** 就绪的入口有多个候选（`App.ready()`、日志事件、RPC 服务器的 `/healthz`），需要收敛为一条规范路径。
- **决定：**
  - 就绪为根入口的 `readyProbe(registry, name?)` 加上现位于 `@go-like/core/web` 的 `createHealthHandler(registry)`（见 D41）。
  - RPC 服务器保留 `GET|HEAD /healthz`，作为监听器存活检查，从不埋点，并保留 `httpRoute`。
  - 不设 `App.ready()` 访问器；不设 `no_ready_probes` 日志事件，规范 Web 示例已经写 `readyProbe(probes)`。
- **理由：** 来自 dogfood 的证据支持保留 `/healthz` 与 `httpRoute`；就绪只保留一条规范路径。

### D8 生命周期观测：`server.failed` 的层标记与观测层 Context

- **问题：** 资源失败若沿用 `server.failed` 会被误报为 `server[index]`；并且 `appContext` 在停止开始时即被取消，观测层的收尾仍需要可用的 Context。
- **决定：**
  - `CoreEvent` 的 `server.failed` 增加 `tier: "telemetry" | "resource" | "server"`。
  - 新增 `AttributeKey.lifecycleTier = "go_like.lifecycle.tier"`，以及三个 `SemconvValue` 成员（`lifecycleTierTelemetry`、`lifecycleTierResource`、`lifecycleTierServer`，值分别为 `"telemetry"`、`"resource"`、`"server"`）。
  - `go_like.server.index` 为层内下标；删除内核的第二个记录器 `recordKernelEvent`。
  - 观测层以 `telemetryContext = withCancel(withoutCancel(appContext))` 启动，在 `Telemetry.stop` 之前一刻才被取消。
- **理由：** 两处都有现有使用者且范围有限。检查与对应的生命周期模型测试覆盖了 `telemetryContext` 的取消顺序。
- **证据：** `appContext` 在停止开始时被取消：`packages/core/src/app.ts:625`。

### D9 `Endpointer.endpoint(ctx)` 执行的绑定置于 `enterRoot` 之下

- **问题：** 监听器绑定若发生在 `Endpointer.endpoint(ctx)` 中（端点先于 `start` 绑定），套接字会在 `app start` span 之下创建，复现观测设计已演示过的泄漏。
- **决定：**
  - 把“由 `Endpointer.endpoint` 执行的监听器绑定”加入 R4b 的位置清单。
  - 每个 core 宿主（RPC 服务器、Web 宿主）与 `@go-like/connectrpc/node`，无论 `endpoint(ctx)` 与 `start(ctx)` 哪个先绑定，都在 `enterRoot(detachSpan(withoutCancel(ctx)), ...)` 之下绑定。core 宿主使用内部的 `enterRoot`；Connect 插头的托管服务器只通过内核调用的 `start`/`endpoint` 接收绑定。
  - 增加一个记录器测试：在活动的 `app start` span 内经 `endpoint(ctx)` 绑定的监听器看不到任何 span。
- **理由：** 端点优先的路径若不如此处理，会在 `app start` span 下创建套接字，即观测设计已演示过的泄漏。

### D10 启动前的 `Telemetry.stop` 不经准入直接排空；引导无需新 API

- **问题：** 应用在 `newApp` 之前先加载配置，若加载失败，已构造的观测包没有被 App 接管，只能手工关闭各 SDK。
- **决定：**
  - `Telemetry.stop(ctx)` 在 `start` 之前调用时，对每个提供方的 `lifecycle.stop` 执行不经准入的两阶段所有者排空，并把该包标记为已停止。
  - 每个 `TelemetryLifecycle` 必须接受“启动前 `stop`”：排空或关闭交给它的原生对象；这成为 `logHandlerConformance`、`tracerProviderConformance`、`meterProviderConformance` 中的一个用例。
  - 对已停止的包再 `start` 会以 `TelemetryAlreadyStartedError` reject（含义改为“不可启动”，代码不变）。
  - 文档化的引导模式：`const tel = newTelemetry(...)`；`const bootCtx = withTelemetry(background(), tel)`；加载配置；失败时 `await tel.stop(ctx)` 并重新抛出；成功则 `newApp(telemetry(tel), ...)`。此后由 App 准入并拥有该包。
  - 不采用：接管已启动的包，以及 `runWithTelemetry(tel, fn)` 辅助函数。
- **理由：** 它消除了“必须手工关闭 SDK”的问题，又不引入第二条所有权转移路径。未准入的提供方也能收到记录，因为原生 SDK 对象在准入前即可工作，失败路径只需一次 `stop`。这与 ADR 0003 一致：准入之前应用仍拥有提供方，并明确要求 core 排空它们。
- **证据：** `research/adr/0003-resident-adapter-ownership.md:31-43`。引导模式见[总设计](README.md)第 6.10 节。

### D11 `server(...)` 与 `resources(...)` 在编译期拒绝 `Telemetry`

- **问题：** `Telemetry` 结构上满足 `Server`，因而可以被误传给 `server(...)` 或 `resources(...)`，类型系统不报错（两个已验证的类型漏洞）。
- **决定：**
  - 根入口声明 `type NotTelemetry = { readonly [K in Exclude<keyof Telemetry, keyof TelemetryLifecycle>]?: never }`。
  - `server(...servers: readonly (Server & NotTelemetry)[])` 与 `resources(...values: readonly (Server & NotTelemetry)[])`。
  - 品牌符号仍是 `/telemetry` 的模块私有符号，运行时的品牌检查保留。
- **理由：** 守卫只在类型层，运行时零成本。已验证：单文件探针在 TypeScript 5.9.3 与 7.1.0-beta 上通过，跨模块探针在 7.1.0-beta 上通过；反例对照出现预期的未使用 `@ts-expect-error` 指令错误（单文件 4 个，跨模块 2 个），证明没有守卫时漏洞确实存在。

### D12 每个内部辅助函数只保留一份；常驻循环下移

- **问题：** 多个领域各自实现了内部辅助函数（可中止的延迟、常驻循环、计时器、`rateLimitMiddleware` 的检查），并且常驻循环违反层级规则。
- **决定：**
  - `internal/context.ts` 的 `waitForDelay` 是唯一的可中止延迟；`resident.ts` 使用它，并删除自己的私有 `sleep`；`newWakeup` 保留，因为它是另一种能力。
  - `resident.ts` 从 `packages/core/src/internal/` 移到不导出的 2 级目录 `packages/core/src/resident/`，因为它调用 1 级的 `detachSpan`/`enterRoot`，而 `internal/` 是 0 级。
  - RPC 通过相对导入使用线编解码与 `isStruct`，并使用 internal 中的辅助函数。
  - 可移植的 `unrefTimer(timer)` 辅助函数置于 `internal/timer.ts`，用于 `packages/server/src/stream.ts` 的两处计时器。
  - `rateLimitMiddleware` 去掉 `snapshot` 检查，等待 `allow` 并记录事件。
  - 发现解析器的重建循环改用 `runResident`，不再用 `maxAttempts: Number.MAX_SAFE_INTEGER` 的 `retry`；这去除了逐次尝试的 promise 链，与 watch 外壳遵循的规则相同。
- **理由：** 内核设计承诺每个辅助函数只有一份，并且层级规则必须通过 `test/portable-lane.test.ts`。
- **证据：** `packages/server/src/stream.ts:138`、`packages/server/src/stream.ts:325`。

### D13 内核遗留的开放问题

- **问题：** 内核设计留下若干开放问题，需要逐项定论。
- **决定：**

  | 主题                       | 答案                                                                         |
  | -------------------------- | ---------------------------------------------------------------------------- |
  | 资源层的停止预算           | 与服务器层共享 `stopTimeout`：没有使用者需要自己的预算；观测层保留自己的预算 |
  | 选项与就绪函数的命名       | `resources`、`readyProbe`                                                    |
  | 就绪入口                   | `readyProbe`（D7）                                                           |
  | 公开的内省入口             | 不设：没有使用者，之后新增是增量                                             |
  | `StructError` 的形态       | 接口加 `isStructError`                                                       |
  | 分布式韧性                 | 推迟：没有使用者                                                             |
  | `newContext`/`fromContext` | 保留（与 kratos 对等，且有内部使用者）                                       |
  | `ProcessSignal`            | 保留，并附带漂移测试                                                         |
  | `lifecycle/testing`        | 暂不设：之后新增是增量                                                       |

  `AppNotReadyError` 保持为导出的接口，与其他 core 错误一致。

- **理由：** 每项都以“没有当前使用者就不新增公共概念，之后新增是增量”为准。

## B schema 与 struct

### D14 一份内置的 Standard Schema 声明，不设 `./schema` 子路径

- **问题：** struct 与 config 各自带有一份 Standard Schema 声明，且有人提议为它单设公开子路径。
- **决定：**
  - `StandardSchemaV1` 与 `StandardTypedV1` 只在 `packages/core/src/internal/standard-schema.ts` 中声明一次（仅类型，附 MIT 声明）；struct 与 config 以相对路径导入。
  - 唯一的公开导入路径是 `@go-like/core/config` 的类型再导出（`export type { StandardSchemaV1, StandardTypedV1 }`）。
  - config 不再依赖 `@standard-schema/spec`；struct 的 `ConfigSchema` 适配检查保留为内核测试。
- **理由：** 设计准则要求只内置一份；两份声明互相可赋值，所以不会破坏任何东西。现有使用者没有按名称导入这个类型，示例都使用 `ConfigSchema`，配置领域的用法也已经从 `/config` 导入。为一个类型单设子路径，等于增加一个没有使用者的 semver 入口。
- **证据：** `examples/enterprise-platform-runtime/src/config.ts:1`、`examples/saas-tenant-api/src/config.ts:1`。

### D15 struct 构建器带 `~standard`，RPC 契约保持只接受 `Struct`

- **问题：** 内核声明要求每个 `Struct` 实现 `StandardSchemaV1`，但原型中的 struct 门面与现有实现不带 `~standard`，使 RPC 契约无法对内核的 `Struct` 编译（集成检查 19 条诊断）。
- **决定：**
  - 内核声明不变：每个 `Struct` 与每个构建器结果都实现 `StandardSchemaV1`。
  - 实现上把 `readonly "~standard"` 放在共享的 `StructMethods` 接口（混入每个构建器结果）与 `ObjectStruct` 上，使 `ArrayStruct`、`RecordStruct`、`TupleStruct`、`UnionStruct`、`DiscriminatedUnionStruct` 也带有它。
  - `Endpoint<Request extends Struct, …>` 保持不变：RPC 契约按产品范围就是 struct 契约；线编解码需要 Standard Schema 没有定义的、感知别名的编码。
  - 原型中的 struct 门面声明是缺陷，需要修正。
  - 实现注记：`~standard` 存在之后，`introspection.ts` 必须去掉 `AnyStruct` 转换。
- **理由：** 已验证：对 `StructMethods` 做模块扩充的补丁消除了全部 19 条诊断；改为去掉交叉类型则会破坏内核的 config 用法。
- **证据：** `packages/struct/src/types.ts:90`（`StructMethods`）；`packages/struct/src/introspection.ts:25`（待去掉的 `AnyStruct` 转换）。
- **待确认：** OQ12。

### D16 `./struct/runtime` 为内部，`./struct/codec` 并入 `/struct`

- **问题：** `struct/runtime` 的符号与线编解码是否公开；`struct/codec` 是否值得单设子路径。
- **决定：**
  - `struct/runtime` 的八个符号以及 `decodeJsonTree`、`encodeParsedJson`、`encodeValidatedJson` 成为 core 内部。
  - `encodeJson` 与 `decodeJson` 移到 `@go-like/core/struct`。
  - 传输层以相对路径导入线编解码与 `isStruct`。
- **理由：** 设计准则规定内部线编解码不导出，且 core 之外没有使用者。`/struct/codec` 只有两个面向用户的函数，它唯一的使用者只需要改导入路径。
- **证据：** `examples/bank-transfer-gateway/src/http.ts:2`。

### D17 新增 `jsonCodec(struct)`：参考 `Codec`

- **问题：** `/broker` 的 `Codec<T>` 没有任何实现，应用只能手写。
- **决定：**
  - `export interface JsonCodec<T> { readonly mediaType: "application/json"; encode(value: T): Uint8Array; decode(bytes: Uint8Array): T }`。
  - `export declare function jsonCodec<S extends StructLike<unknown, unknown, boolean>>(struct: S): JsonCodec<Infer<S>>`。
  - `encode` 为 `utf8(JSON.stringify(encodeJson(struct, value)))`；`decode` 为 `decodeJson(struct, JSON.parse(fatalUtf8(bytes)))`，失败时抛出 `StructError`。
  - `JsonCodec<T>` 在结构上就是 `/broker` 的 `Codec<T>`，所以 `/struct` 不导入 `/broker`。
  - 文档记录“RPC 按决定只用 JSON”（Connect 覆盖 protobuf）。不采用：带 schema 的 `enqueue`（没有使用者）。
- **理由：** 存在当前使用者：一个示例为此手写了 JSON 编解码与 17 行校验器。
- **证据：** `examples/notification-delivery/src/events.ts:19-51`。

## C RPC 与 Web

### D18 RPC 的观测修订并入观测设计

- **问题：** RPC 设计对观测契约提出若干修订，需要并入观测设计，否则两份设计不一致（集成检查中发现了相关的不一致）。
- **决定：** 采纳 RPC 设计中的下列各项：
  - 仅对 `rpc.server`：载体为空时，嵌套在显式 ctx 的 span 之下，而不是隐式 span。
  - `BodyEndOptions.onEnd?: () => void`。
  - `SemconvValue.rpcSystemGrpc: "grpc"` 与 `rpcSystemConnectrpc: "connectrpc"`。
  - `endAtBodyEnd` 把 `bodyUsed` 或 null 的 body 视为终态。
  - 在处理器之前即被拒绝的已注册路由保留 `rpc.method`。
  - `rpc.server` 单元在元数据与期限派生之前开始。
  - 在 core Web 宿主上，Connect 产生两个 SERVER span。
  - 另外新增：`rpc.status_code` 的取值因系统而异。对 `go_like` 是 `ServiceError` 的代码或 `"ok"`；对 `grpc` 与 `connectrpc` 是规范的大写 gRPC 状态名（`OK`、`DEADLINE_EXCEEDED`），Connect 插头的大小写保持不变。
- **理由：** 每一项都有当前使用者，且范围有限。“空载体嵌套在显式 ctx 之下”不会采用陈旧 span，因为宿主以 `detachSpan` 为根，gRPC 服务器总是传入载体。
- **证据：** OpenTelemetry 语义约定 1.45.0（`@opentelemetry/semantic-conventions@1.45.0`）：`dist/stable_attributes.d.cts:1451-1461` 给出 `rpc.status_code` 的示例值 `OK`、`DEADLINE_EXCEEDED`、`-32602`，并说明各框架自行文档化取值；`dist/stable_attributes.d.cts:1479` 中 `grpc` 为稳定值，`dist/experimental_attributes.d.cts:14220` 中 `connectrpc` 为实验值。对应补丁在集成检查中验证通过。

### D19 `contextHandler` 回退到 `background()`

- **问题：** `contextHandler` 与宿主无关，没有 `hostCtx`，[总设计](README.md)第 5.3 节 R3 要求的“由宿主的准入 ctx 派生”无法实现。
- **决定：**
  - `contextHandler` 从 `requestContext(request) ?? background()` 派生。
  - 并非由 core 宿主创建的 `Request`（被框架克隆，或在单元测试中直接调用）会丢失 AppInfo 与观测；README 写明这一点，并有测试断言。
  - 增加 Hono、elysia、h3 的一致性用例。
- **理由：** 这是在没有 `hostCtx` 的前提下唯一能实现的规则。

### D20 发现机制与 `selectEndpoint` 属于 `@go-like/core/registry`

- **问题：** 选择器、过滤器与解析器已在 `/registry`，但 RPC 设计把端点选择放在 `./client/discovery`，造成两处声明与悬空导入（`connectrpc/node` 出现 TS2305）。
- **决定：**
  - 发现设计在 `registry/selection.ts` 中新增 `EndpointSelection` 与 `selectEndpoint(ctx, selector, instances)`，内容取自 RPC 设计；`DiscoveryResolver` 与 `newDiscoveryResolver` 本来就在其中。
  - `./client/discovery` 不再存在。
- **理由：** 选择器、过滤器与解析器已经在那里；两个现有使用者是 core 客户端与 `@go-like/connectrpc/node`；迫使端点选择放进 client 的循环依赖已经消失。对应补丁在集成检查中清除了该 TS2305。

### D21 `./transport/provider` 保持公开，内容按 RPC 设计

- **问题：** 打包设计与 RPC 设计对 `./transport/provider` 的内容不一致。
- **决定：** 它导出四个错误工厂、`newServerContext`，以及缩减后的 `observeResponseBody` 及其两个类型。
- **理由：** `@go-like/connectrpc` 导入 `newServerContext`；内存与 HTTP 传输需要错误工厂和 body 观察器。

### D22 逐次调用选项使用品牌类型

- **问题：** `ServiceCallOption { (value: never): unknown }` 接受任何函数（已验证的类型漏洞），`withEndpoint(...)` 或服务器选项会被误当作逐次调用选项。
- **决定：**
  - `/transport` 声明 `declare const callOptionBrand: unique symbol; export interface ServiceCallOption { readonly [callOptionBrand]: "CallOption" }`。
  - `/client` 声明 `export type CallOption = ServiceCallOption & ((options: CallOptions) => CallOptions)`。
  - `withFilter` 与 `withRetry` 是仅有的生产者（冻结函数，经品牌定型，与 `AppOption` 相同）；`/transport` 仍不导入 `/client`。
- **理由：** 已验证：`withEndpoint(...)` 与服务器选项在 TypeScript 5.9.3 和 7.1.0-beta 上都被拒绝作为逐次调用选项，没有品牌的对照则两者都接受。

### D23 Connect 插头为 `@go-like/connectrpc`（含 `./node`），是 core 中间件模型之外的集成

- **问题：** Connect/gRPC 插头的包名与位置、它与 core 中间件、策略与 `ServiceError` 映射的关系都需要定论。
- **决定：**
  - 包名为 `@go-like/connectrpc`：`.` 可移植，`./node` 是托管的 gRPC 服务器与客户端。
  - `protoc-gen-like` 生成指向 `@go-like/core/context` 与 `@go-like/connectrpc` 的导入。
  - 该插头填充 Web 的 `Handler` 与生命周期的 `Server`/`Endpointer`，并通过 `/telemetry/provider` 自己拥有其工作单元。
  - core 的 `Middleware`、限流与熔断策略、`ServiceError` 映射都不作用于 Connect 处理器；文档记录这一对等性缺口。
- **理由：**
  - 设计准则按被适配的生态命名插头（如 Connect-ES），并把运行时绑定命名为 `/node`。
  - 打包设计支持 `native` 的唯一论据是今天的名称，但这些包尚未发布。
  - 没有示例使用 gRPC 或策略中间件（检索 `examples/*/src` 中的 `transport-grpc-buf`、`rateLimitMiddleware`、`circuitBreakerMiddleware`，没有匹配），所以另一方案没有当前使用者。
  - “不设共享线上 Transport”的保留决定不变。
- **待确认：** OQ11（范围）。**已确认：** OQ3（包名，2026-11-16）。

### D24 RPC 的开放问题

- **问题：** RPC 设计留下一组开放问题与一项关于传输类型拆分的批评，需要逐项定论。
- **决定：**
  - 名称按 D23；已批准的 web 与 transport 名称成为 core 子路径（OQ3 已确认）。
  - 第三方依赖按 peer 规则（D43）。
  - 暂不设 `transport/testing`。
  - 暂不设 `ServiceError` 到 Connect 的映射（待确认 OQ11）。
  - 宿主的请求 Context 在第一个终态 body 事件时结束。
  - 诊断回退由 D38 规定。
  - `Transport.kind()` 为必需成员；`Listener.addr()` 返回绝对 URL；线上头部名称不导出。
  - 把 Node Web 宿主并到 Bun 宿主所用的 `NativeBind` 生命周期核心、让 Web 宿主与 HTTP 传输共用一个 Node HTTP 宿主，属于不影响公开 API 的内部重构，划为范围外。
  - 关于“传输类型应拆分为仅拨号与完整两种”的批评，只作为文档处理：规范的 Node 服务在服务器与客户端两侧都使用 `newNodeHTTPTransport()`；`/transport/http` 在文档中定位为可移植（浏览器或边缘）客户端使用。拆分类型会破坏 go-micro 形状的 `Transport` 插座，而误用会在启动时以带类型的错误失败。
- **理由：** 每项答案都选择了当前使用者实际需要的最小形态。
- **待确认：** OQ11。**已确认：** OQ3（2026-11-16）。

### D25 不统一 `HTTPExecutor` 与 `Fetch`

- **问题：** `HTTPExecutor` 与 `Fetch` 能否合并为一个包装类型。
- **决定：** `HTTPExecutor` 留在 `/transport/http`，`Fetch` 留在 `/fetch`。
- **理由：** 没有使用者把同一个包装同时传给两者，且传输层的 `(input, init)` 调用形态已经覆盖流式 body；之后让 `executor(...)` 接受 `Fetch` 是增量。

## D 发现与配置

### D26 HTTP 后端插头为其唯一共享客户端保留根入口，构造函数以客户端为首参

- **问题：** 插头规则原先只允许列出插座子路径，但 consul、etcd、vault、kubernetes 的多个插座共用一个协议客户端。
- **决定：**
  - `@go-like/consul`、`@go-like/etcd`、`@go-like/vault`、`@go-like/kubernetes` 导出 `.`，包含 `newXClient(options)`、客户端类型与错误族。
  - 各插座的构造函数以客户端为首参。
  - 插头规则改为“没有根入口，除非根入口就是插座，或承载该插头唯一的共享客户端”。
  - 新增发布检查：共享某个模块私有的客户端品牌的子路径，其 `dist` 中该品牌必须恰有一处定义。
- **理由：** 设计准则为“一个后端一个包”给出的理由正是“共享一个协议客户端”；三个示例会组合同一后端的多个插座；扁平选项加可选客户端会成为同一件事的两种写法。

### D27 插头的运行时绑定为 `<socket>/node`

- **问题：** zookeeper 与 mdns 的 Node 绑定放在哪里，才能既符合命名规则，又让 `./registry` 保持可移植。
- **决定：**
  - `@go-like/zookeeper/registry` 可移植，从不导入 `node-zookeeper-client`；原生客户端工厂在 `@go-like/zookeeper/registry/node`，`client` 选项变为必需。
  - mDNS 宿主在 `@go-like/mdns/registry/node`。
  - `node-zookeeper-client` 是常规依赖，仅由绑定入口加载。
- **理由：** 一条规则即可，并与 core 的 `<concept>/node` 一致；这也是 `./registry` 留在可移植通道的唯一办法。
- **已确认：** OQ3（2026-11-16）。

### D28 配置解码器的名称

- **问题：** 配置的 JSON 解码器与 struct 的 `decodeJson` 同名；YAML 解码器的签名不允许说明来源。
- **决定：**
  - 配置的 JSON 解码器命名为 `jsonDecoder: ConfigDecoder`，沿用今天的 `jsonFileDecoder` 以及其他 `json<X>Decoder` 的命名；struct 保留 `decodeJson`。
  - `@go-like/yaml/config` 保留已批准的名称 `decodeYaml`，但采用 `ConfigDecoder` 的签名 `(text: string, origin: string): ConfigObject`，使 `admitConfigObject(value, origin)` 能指明来源。
- **理由：** 只重命名非批准的新名称，其余沿用已批准或现有的名称。

### D29 发现与配置的开放问题

- **问题：** 发现与配置设计留下一组开放问题，需要逐项定论。
- **决定：**

  | 主题                       | 答案                                                                         |
  | -------------------------- | ---------------------------------------------------------------------------- |
  | etcd 鉴权令牌              | 使用原始令牌，并由必须通过的 etcd 鉴权端到端测试把关；若不通过，只在一处切换 |
  | 缺失的配置文档             | 默认失败关闭，新增 `optional` 标志（没有使用者依赖缺失时等于 `{}`）          |
  | 公开的 `detached(ctx, fn)` | 不设（D40）                                                                  |
  | `watchRetrying` 事件       | 不设：没有使用者，之后新增是增量                                             |
  | 重载退避                   | 保持固定                                                                     |
  | 注册表一致性用例集         | 可按测试 API 规则增加用例（OQ10）                                            |
  | EWMA 代码                  | 不变                                                                         |
  | mDNS 选项名                | 不变（已批准的名称，以命名空间导入使用，见 D50）                             |

  consul 示例按注册表实例创建 `newIdentityLocks()`，而不是在模块作用域创建。

- **理由：** 各项均以“没有现有使用者就不新增”为准。
- **待确认：** OQ10（注册表一致性用例的增长规则）。

## E 数据与任务

### D30 文件存储是插头 `@go-like/file`

- **问题：** `store-file` 应留在 core 还是成为插头。
- **决定：** `@go-like/file` 提供 `./store`（可移植，基于插头自有的 `FileStoreHost`）与 `./store/node`（`node:fs` 宿主）；core 没有任何 `./store/file` 入口。
- **理由：** 设计准则只接纳无操作、内存与进程内的参考实现，以及“core 自身机制需要”的宿主绑定。core 中没有任何代码读取文件存储，而配置的文件宿主被配置机制所需要。带锁与崩溃语义的持久存储超出“没有外部系统”的范围。
- **已确认：** OQ3（包名，2026-11-16）。

### D31 移除 NATS 仅有生命周期的 Server，以及 croner/bullmq 的生命周期适配器

- **问题：** `newNatsCoreServer`、`newNatsJetStreamServer`、`newCronerServer`、`newBullMqWorkerServer` 只提供生命周期，从不经手消息或任务。
- **决定：**
  - 移除 `newNatsCoreServer`、`newNatsJetStreamServer` 及其选项与错误类型，以及 `newCronerServer`、`newBullMqWorkerServer`。
  - 任务插头中只有 bullmq（队列资源与 worker）实现 `Server`；croner 实现 `Schedule`；bullmq 不再依赖 `ioredis`。
- **理由：** 从不经手消息的 Server 无法被埋点，且在其包之外没有使用者；任务概念拥有运行本身。

### D32 一条一致性命名规则、一个用例类型、一个测试入口

- **问题：** 各领域的一致性用例集命名、用例类型与子路径各不相同，并且存在重复的用例类型。
- **决定：**
  - 每个公开的用例集都是 `<concept>Conformance(subject): readonly ConformanceCase[]`，从 `@go-like/core/testing` 导出（见 D41）。
  - 改名：`registryConformanceCases` 改为 `registryConformance`；`RegistryConformanceCase` 改为 `ConformanceCase`；缓存与存储的对应名称已经改过。
  - `brokerTelemetryConformance` 接受 `BrokerConformanceSubject`，删除 `BrokerTelemetrySubject`。
  - `jobTelemetryConformance` 接受 `JobTelemetrySubject { queue?, schedule? }`。
  - `go_like.job.system` 文档化取值 `interval`、`memory`、`croner`、`bullmq`。
  - 缺少的用例集（`Transport`、`Server`、`ConfigSource`、`FileCapability`、`Selector`、`RateLimiter`、插头自有宿主）现在不新增：之后新增是增量。
- **理由：** 一条命名规则、一个类型、一个入口，插头作者只需要学一次。
- **待确认：** OQ10（用例集作为公开 API 发布）。

### D33 插头继续调用 core 工具包，不采纳把埋点上移的提议

- **问题：** 跨领域评审提议把消费侧的埋点移入 `newBrokerServer`，让插头不再自己调用工具包。
- **决定：**
  - broker 插头调用 `deliver`/`publish`，任务插头调用 `dispatchJob`/`enqueue`，与观测设计及数据设计一致。
  - 每个一方的 broker 与任务插头都把 `brokerConformance` 加 `brokerTelemetryConformance`（或 `jobQueueConformance` 加 `jobTelemetryConformance`）作为必需的 CI 任务运行。
  - 插头作者指南把工具包契约写成插座契约的一部分。
  - 不新增 `Broker.system()` 或 `JobQueue.system()` 成员：由插头把 `system` 传给工具包。
- **理由：**
  - 调用已发布的 SDK 函数既没有重新实现机制，也没有包装 core 的调用点。
  - 把消费移入 `newBrokerServer` 需要新增插座成员；经 `eventBroker` 的 `EventMessage` 拿不到头部；并且会让直接 `subscribe` 的使用者悄悄失去逐次投递的 Context，而设计准则要求提供它。
  - 观测设计的评审也保留了工具包，并否决了在 core 中提供发布前端。

### D34 `./job/memory` 转为内部，`newIntervalSchedule` 并入 `/job`

- **问题：** 公开的内存任务队列只有测试使用；`interval` 是否值得单设子路径。
- **决定：**
  - `newMemoryJobQueue` 保持为 core 内部模块，供 core 的任务测试与 `jobQueueConformance` 自测使用。
  - `newIntervalSchedule` 从 `@go-like/core/job` 导出；它是纯时间表，如同 `/resilience` 中的 `exponentialBackoff`。
- **理由：** 公开内存队列的唯一使用者是测试，是论证最弱的一项；之后新增该入口是非破坏性的。

### D35 数据领域的开放问题

- **问题：** 数据设计留下若干开放问题，以及两项文档性批评。
- **决定：**
  - 重叠策略固定，没有“跳过运行”事件。
  - 逐次投递的 ctx 在处理器结算时取消。
  - 文档（JetStream）：传给 `subscribe` 的 `topic` 是代码中定义的订阅标签，用于 `process {subscription}`；应传入消费者的过滤主题，由消息工厂选择消息。
  - 文档（`JobBackoff`）：按行为描述（第 _k_ 次尝试之前的延迟），不描述为“BullMQ 的公式”。
  - 任务的永久失败问题交给维护者（OQ13）。
- **理由：** 重叠策略与取消时机各只有一种符合现有使用者的选择；其余两项属于文档澄清。
- **待确认：** OQ13。

## F 观测

### D36 重述并实测禁用路径的成本声明

- **问题：** 观测设计对禁用路径成本的表述需要重述，并在最终路径上实测。
- **决定：**
  - 观测设计的禁用成本原则改为“在语义所需的 Context 派生之外，只多一次 Context 查找”（见[总设计](README.md)第 5.8 节）。
  - CI 基准在 Bun 与 Node 上、分别开启与关闭观测，测量最终路径：内存传输上的一元 RPC、一次 Web 请求、一次内存 broker 投递、一次任务运行。
- **理由：** 声明应当能被测量，且基准覆盖实际使用的路径。

### D37 重复 `traceparent` 的端到端测试是发布关卡

- **问题：** 当 OTel 自动埋点与 go-like 同时追加 `traceparent` 时，下游看到重复头部，其解析行为影响跨服务 trace。
- **决定：**
  - 配置 A 与 B、Node 与 Bun 的端到端测试必须在首次发布前运行，并据其结果决定重复 `traceparent` 的策略（OQ6）。
  - 不让 `requireContextManager` 在存在全局传播器时失败；OTel 插头的 WARN 保留。
- **理由：** 这是线上行为，应基于实测而不是预判；混合版本的集群依赖它。
- **已确认：** OQ6（2026-11-17）。
- **OQ6 决定（2026-11-17，维护者）：** 实测只有“配置 B + Node + 可移植 fetch”出现两个 `traceparent`。原因是上游 `@opentelemetry/instrumentation-undici` 在请求已带 `traceparent` 时仍追加一个（[#2796](https://github.com/open-telemetry/opentelemetry-js-contrib/issues/2796)、[#3711](https://github.com/open-telemetry/opentelemetry-js-contrib/issues/3711)，修复 [PR #3713](https://github.com/open-telemetry/opentelemetry-js-contrib/pull/3713) 尚未合并）。go-like 不为上游缺陷做规避：继续严格按 W3C 解析，不采用 (b)；在相关代码的 JSDoc 中注明该上游缺陷与链接。发布关卡 `release-traceparent` 对该格按正确预期断言，并以“已知上游失败”暂时放行；上游修复后该格不再复现，关卡会失败，提示删除这条标记。

### D38 诊断回退的默认值

- **问题：** 没有安装任何日志处理器的应用，看不到服务器失败、配置终态失败、心跳丢失、响应失败与任务失败。
- **决定（推荐默认）：**
  - ctx 不带 `LogHandler` 时，内部的 `recordEvent` 与公开的 `logEvent` 只把 `error` 级的诊断事件（绝不包括完成记录，也绝不包括 `warn`/`info`）以一行 JSON 写入 `console.error`。
  - 该行包含 `event.name`、`error.type`、`go_like.operation`，绝不包含错误文本（脱敏规则）。
  - 取代此前“仅 node 桥接的回退”；不设公开的控制台处理器，不设 `./log/console` 子路径。
- **理由：** 否则这些失败在没有观测的应用里不可见；设计准则允许在有正当理由时提供控制台输出；它不是全局注册，在成功路径上没有成本。
- **待确认：** OQ9。

### D39 OTel 与其他观测插头的修正

- **问题：** 评审发现 OTel 桥接及其他观测插头存在若干缺陷与不一致。
- **决定：**
  - **OTel `extract`：** 当 OTel 传播器既没有给出有效的 span context 也没有 baggage 时，`extract` 原样返回 `ctx`。提取出的 OTel 基础以冻结的远端 `Span` 对象为键（模块级 `WeakMap<Span, OtelContext>`），而不是插头私有的 ctx 键，因此 `detachSpan` 会丢弃它，`enter(detachSpan(ctx))` 得到 `ROOT_CONTEXT`。仅含 baggage 的提取不带入隐式上下文（写入文档）。`tracerProviderConformance` 新增用例：`enter(detachSpan(extract(...)))` 得到空的隐式上下文。
  - **span 身份：** 在观测设计中写入规范性语句：core 存储并返回 `TracerProvider.startSpan` 返回的原样 `Span` 实例；它在调用点以 try/catch 隔离插头故障，而不是包装 span。`tracerProviderConformance` 新增断言该身份的用例。
  - **OTel 通道：** 可移植（P）；第三方嵌套需要应用的 ALS context manager（写入 README）。
  - **事件名：** 插头的事件名是模块私有常量，没有运行时前缀校验。
  - **Prometheus：** 抓取用 `Handler` 留在 `./metric`，作为文档化的例外；它只为该 meter provider 的注册表存在，单设 `./web` 入口只会为一个函数增加一个子路径。
  - **`shutdownTimeoutMs: 0`：** 保持今天的含义“立即让所有者等待失败”，并修正观测设计中的骨架。
  - **服务身份：** 文档处理。OTel SDK 的 `Resource` 归应用所有，README 展示如何用传给 `newApp` 的同一组 `name`/`version` 常量构造它；仅当 SDK 通过公开 API 暴露提供方的 resource 时才采纳准入 WARN（尚未验证，由插头实现时核实）；不恢复 `resourceAttributes(info)`。
  - **pino：** `defaultPinoDrainTimeoutMs` 保持私有（没有使用者，之后新增是增量）。
  - **winston：** 与 pino 一样，在准入时绑定 `logger.child(resourceFromContext(ctx))`（插头内部实现，输出对等）。
  - **标签：** 观测设计点明 otel 旧 `RequestComponent` 的后继（`Unit` 种类）与 `RequestOutcome` 的后继（`error.type`、`go_like.outcome`），迁移表中对应行写作“已替换”并指向这些后继。
  - **新增迁移行：** 列出 `OtelMetricsOptions`、`OtelLogsOptions`、`OtelTracerProvider`、`OtelMeterProvider`、`OtelLogHandler`，如打包设计所声明。
- **理由：** 每项修正都针对已定位的具体缺陷，范围有限，并且保持与既有行为的一致。
- **证据：** `shutdownTimeoutMs: 0` 的现行含义见 `packages/otel/src/runtime.ts:200-235`。

### D40 单元内惰性创建的原生资源作为测试项，暂不设公开的 `detached()`

- **问题：** 工作单元内惰性创建的原生资源（如连接池中第二次调用建立的连接）可能捕获到单元的 span，目前只是推断，尚未验证。
- **决定：**
  - 端到端测试增加一个用例：连接池上的第二次调用，在套接字级钩子中看到它自己的 CLIENT span；覆盖 core 的 HTTP 传输与 `@go-like/connectrpc/node`。
  - 按其结果再决定修复方式。core 的调用点使用内部的 `enterRoot`；只有当 Connect 插头或某个注册表插头出现经验证的泄漏时，才向 `/telemetry/provider` 增加公开的 `detached(ctx, fn)`。
  - 不设公开的流完成辅助函数：Connect 插头保留自己的分类，并增加镜像 core `rpcFailure` 的测试。
- **理由：** 目前没有经验证的泄漏；ZooKeeper 与 mDNS 没有自动埋点；之后新增该函数是增量。

## G 打包、构建与命名

### D41 最终的 core 子路径列表（41 个入口）

- **问题：** 各领域设计给出的子路径并集有 57 个入口，数量过多且存在重复与没有使用者的入口。
- **决定：** 采用[总设计](README.md)第 3.4 节的 41 个入口，其中的折叠如下：
  - `struct/codec` 并入 `/struct`；`trace/w3c` 并入 `/trace`（它是默认传播器，已被 `/telemetry` 加载）；`web/health` 并入 `/web`；`config/env` 与 `config/file` 并入 `/config`（二者均可移植）。
  - `fetch/provider` 并入 `/fetch`：该概念就是 `Fetch` 插座加其上的机制，没有需要分开的面向使用者的 API，设计准则中按受众划分 `/provider` 的规则不适用；`cache/provider` 并入 `/cache`（只有一个选项解析器）。
  - `event` 并入 `/broker`；`job/interval` 并入 `/job`；所有 `/testing` 用例集并入 `./testing`。
  - 移除：`./schema`、`./job/memory`、`./struct/runtime`、`./client/discovery`、`./store/file`、`./store/file/node`。
  - “把六个 `/memory` 实现折入各自概念入口”被否决：设计准则把参考实现命名为 `/<concept>/<impl>`；包拓扑设计否决把默认实现聚合进契约入口；插头导入概念入口时，会在不打包的运行时中加载内存实现代码。
  - 名称检查：没有任何一项合并造成冲突（已对照各设计的导出列表核对）。
- **理由：** 每个入口都是一项 semver 承诺，首次发布后新增入口是非破坏性的，删除则是破坏性的；没有现有使用者失去访问，只是导入路径变化。
- **证据：** `research/designs/package-topology.md:15`（否决把默认实现聚合进契约入口）。对设计准则的修订见[总设计](README.md)第 2.5 节。
- **已确认：** OQ1（2026-11-16）。

### D42 最终的包列表（20 个包）与 codemod

- **问题：** 打包设计与其他设计对包的清单与迁移目标不一致，迁移表中有 8 处悬空目标。
- **决定：** 采用[总设计](README.md)第 3.3 节的 20 个包（75 个公开入口，其中插头与生成器 34 个），迁移目标按第 10.3 节的 codemod 表。
- **理由：** 一份统一的清单，使包名、入口与迁移表相互一致。
- **已确认：** OQ1、OQ3（2026-11-16）。

### D43 第三方依赖的种类

- **问题：** 设计准则要求插头的第三方依赖一律为常规依赖，但对 pino、OTel 等库，这会使模块身份、符号或全局注册表在应用与插头之间不一致。
- **决定：** 规则：
  - **peer：** 插头使用该库的运行时代码，或注册到应用构造的该库对象之中，因而模块身份、符号、全局注册表或线上脚本兼容性必须一致。包括 `@opentelemetry/api`、`pino`、`prom-client`、`bullmq`、`@connectrpc/connect`、`@bufbuild/protobuf`。
  - **可选 peer：** 插头只接收应用的对象，运行时仅做类型导入。包括 `winston`、`amqplib`、`@nats-io/jetstream`。
  - **精确固定版本的常规依赖：** 插头构造并封装该库，或仅通过鸭子类型互操作。包括 `@redis/client`、`croner`、`js-yaml`、`node-zookeeper-client`、`@nats-io/transport-node`、`@connectrpc/connect-node`、`@bufbuild/protoplugin`。
- **理由：** 判据是“是否需要身份一致”，而不是“谁构造对象”。依据包括：pino 的 `streamSym`、OTel 的全局版本检查、BullMQ 的 Lua 脚本、Connect 的描述符身份，以及 NATS 头部以鸭子类型处理。
- **已确认：** OQ4（2026-11-16；对设计准则的修订，见[总设计](README.md)第 2.5 节）。

### D44 插头清单中 core 的依赖形式

- **问题：** 插头对 core 的依赖应如何声明，发现设计中的示意写法与打包设计不一致。
- **决定：** `peerDependencies["@go-like/core"]` 为锁步的精确版本，`devDependencies["@go-like/core"]` 为 `"workspace:*"`；发现设计中的示意写法据此修正。
- **理由：** 保证全应用只有一份 core 实例；对第三方插头的范围策略见 OQ5。
- **待确认：** OQ5（第三方插头的策略）。

### D45 core 的 `lib` 包含 `ES2024.Promise`

- **问题：** `Promise.withResolvers` 目前只是因为 Bun 的环境类型才通过类型检查，core 自己的源码构建缺少这一声明。
- **决定：** core 源码的 `lib` 为 `["ES2023", "ES2024.String", "ES2024.Promise", "DOM", "DOM.Iterable"]`。
- **理由：** 让源码构建显式获得 `ES2024.Promise`，不再依赖环境类型。
- **证据：** `packages/core/src/app.ts:785` 使用 `Promise.withResolvers()`；目前仅靠 `packages/core/tsconfig.test.json:5` 的环境类型通过类型检查。

### D46 绑定入口的声明不引用 Node 类型

- **问题：** 打包设计允许保留 `/// <reference types="node" />`，而内核与 RPC 设计要求使用者无需安装 `@types/node`，两份文档彼此不一致。
- **决定：**
  - 绑定的源文件可以在内部使用 Node 类型，方式是不带 `preserve` 的 `/// <reference types="node" />`（TypeScript 5.5 及以上会把它从生成的 `.d.ts` 中丢弃），或每个绑定使用独立的 tsconfig。
  - 每个绑定入口的公开 `.d.ts` 不得引用 Node 类型：`ProcessSignal` 取代 `NodeJS.Signals`，公开类型避免 `node:*`。
  - core 在使用者可见的任何字段中都不声明 `@types/node`。
  - 发布检查：每个绑定入口的 `.d.ts` 都能在 `types: []` 的使用者中编译。
- **理由：** 这样使用者无需 `@types/node`，这正是内核与 RPC 设计的目标；若保留该指令，绑定入口的使用者就必须安装 `@types/node`。

### D47 导入层级与循环

- **问题：** core 内部模块之间的导入层级与循环需要明确允许与禁止的范围。
- **决定：**
  - 允许 `telemetry` 与 `log`、`metric`、`trace` 之间的仅类型循环：`telemetry` 以仅类型方式导入这三者，它们对 `telemetry` 常量的值导入是单向的。
  - `test/portable-lane.test.ts` 在 core 模块之间出现任何值级别的循环时失败。
  - 层级遵循打包设计，并加上位于 2 级的 `resident/`（D12）。
- **理由：** 仅类型的循环在运行时不存在，而值循环会破坏层级模型。

### D48 文件布局：以所属领域的目录树为准

- **问题：** 各领域设计给出的文件布局不一致。
- **决定：**
  - 目录树取自内核、发现与配置、数据与任务各领域设计（`src/node/index.ts`、`src/lifecycle/index.ts`、`<concept>/memory.ts`）。
  - 被合并的子路径把文件留在吸收它的概念目录内（例如 `src/web/health.ts`、`src/trace/w3c.ts`、`src/config/env.ts`、`src/config/file.ts`、`src/broker/event.ts`、`src/job/interval.ts`、`src/struct/codec.ts`、`src/fetch/client.ts`）。
  - `./testing` 是 `src/testing/index.ts`，再导出各领域留在其概念旁的用例集文件（`src/<concept>/testing.ts`，不导出）。
  - `exports` 的取值由[总设计](README.md)第 3.4 节生成。
- **理由：** 文件布局的所有权应与各概念的所有权一致。

### D49 发布检查的新增项

- **问题：** 需要补充发布检查，并把迁移第 0 步升级为关卡，以发现跨领域的类型不一致与共享品牌被重复定义。
- **决定：**
  - 新增两项检查：共享品牌的唯一性（D26），以及绑定入口 `.d.ts` 在使用者中的编译检查（D46）。
  - 把迁移第 0 步设为关卡：在一个由各领域声明构成的并集 tsconfig 中检查，并以四份典型的应用入口 `main.ts` 作为 fixture。它必须在任何代码移动之前，在 TypeScript 5.9.3 与 7.1.0-beta 上无垫片地 exit 0。
- **理由：** 把集成检查前移到迁移之前，避免在代码移动之后才发现声明不一致。迁移步骤见[总设计](README.md)第 10.5 节。

### D50 名称冲突与导入风格

- **问题：** 不同模块导出同名符号，需要决定哪些改名、哪些保留。
- **决定：**
  - 只改名：配置的 `decodeJson`（D28）。
  - 保留（已批准或现有名称，没有必须修改的理由）：`/metadata` 与 `/transport/provider` 中的 `newServerContext`，`/lifecycle` 与 `/server` 中的 `Server`，传输的 `withTimeout`，客户端的 `middleware`/`use`，根入口的 `context`/`endpoint`/`metadata`/`server`/`telemetry`，缓存与存储的 `expiresIn`/`clock`，以及 mDNS 的选项名。
  - 文档化的风格：对发生冲突的模块使用命名空间导入，例如 `import * as app from "@go-like/core"`，并在插头作者文档中说明别名。
  - 会修改自身的选项风格（`ConfigOption`、`PinoHandlerOption`、`NatsCoreOption`）保持不变；改动只会引入没有使用者受益的变动。
- **理由：** 把变动限制在必须修复的冲突上。

### D51 迁移表的标签与悬空目标

- **问题：** 迁移表中，不同设计对同一符号的后继标注不一致，部分目标悬空。
- **决定：**
  - 以所属设计的标签为准：otel 取观测设计；`transport` 的 `logger` 取 RPC 设计，即“已由 `logEvent` 取代”。
  - 选项字段的后继写作限定字段：`OtelTracingOptions.shutdownTimeoutMs` 及其两个同级字段、`InstrumentOptions.attributeKeys`、`TelemetryOptions.completionLogs`。
  - `protocGenLike` 在 RPC 设计中声明为“函数 API 不变：`protocGenLike(...)`，今天位于 `packages/protoc-gen-like/src/index.ts`”，仅生成的导入路径变化。
  - `logEvent` 引用为 `@go-like/core/telemetry/provider`。
  - `KubernetesHttpError` 的代码变化（`GO_LIKE_KUBERNETES_CONFIG_HTTP` 变为 `GO_LIKE_KUBERNETES_HTTP`）与 consul、etcd、vault 的存储合并都是有意为之。
  - 本记录引起的迁移映射变化：
    - `@go-like/struct/codec` 的 `encodeJson`/`decodeJson` 移到 `@go-like/core/struct`；
    - `@go-like/config/env`（4 个）与 `@go-like/config/file`（保留 8 个）移到 `@go-like/core/config`；
    - `jsonFileDecoder`、`jsonConsulDecoder`、`jsonEtcdDecoder`、`jsonKubernetesDecoder` 移到 `@go-like/core/config` 的 `jsonDecoder`；
    - `@go-like/web/health`（2 个）移到 `@go-like/core/web`；
    - `@go-like/event`（5 个）移到 `@go-like/core/broker`；
    - `@go-like/cache/provider` 的 `putOptions` 移到 `@go-like/core/cache`；
    - 注册表、缓存与存储的测试符号移到 `@go-like/core/testing`，其中 `registryConformanceCases` 改为 `registryConformance`；
    - `@go-like/registry-mdns/node` 的 `newNodeMDNSHost` 移到 `@go-like/mdns/registry/node`。
  - 按去向统计的数量只因 `jsonDecoder` 改名而变化（4 个被合并的目标，去向不变）。
- **理由：** 迁移表以所属设计的说明为准，使标签与目标一致且目标都存在。

### D52 “刻意不在 core 中”的清单

- **问题：** 一些常见能力有意不进入 core，需要在文档中说明理由，避免被反复提出。
- **决定：** core 的 README 列出每个概念及理由：
  - 鉴权：没有使用者，只有 mTLS 对端身份；
  - 错误 `reason` 与 gRPC 映射：OQ11；
  - 熔断器工厂与分布式限流：没有使用者；
  - 自适应削峰：没有使用者；
  - 默认信号处理：显式 `signal()`，没有隐式的进程钩子；
  - RPC 编解码插座：按决定只用 JSON（D17）；
  - 路由器：ADR 0001。
- **理由：** 把“不做什么”与理由写下来，使边界可以被审查。
- **待确认：** OQ11（错误 `reason` 与 gRPC 映射）。

## 待维护者确认的问题

下列问题按撤回成本排序，每项给出文档所采用的推荐默认值。

2026-11-16 维护者已按推荐默认值批准 OQ1-OQ4，其中 OQ1 的批复是“允许任何破坏性修改”。2026-11-17 维护者据发布关卡实测决定 OQ6（见 D37）。OQ5、OQ7-OQ14 仍待确认。

| 编号 | 问题                                                                                                                                                                                                                                                                                                                                               | 推荐默认                                                                                                                                                                                                             | 影响                                                                                     |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| OQ1  | 批准最终公开面：core 41 个入口与插头 34 个入口（见[总设计](README.md)第 3.3、3.4 节），包括对设计准则的修订：一个 `./testing`；`/fetch` 与 `/cache` 无 `/provider`；只在纯函数或默认实现处折叠参考实现（`w3c`、`interval`）。移除：`./schema`、`./job/memory`、`./struct/runtime`、`./client/discovery`、`./store/file*`                           | 批准                                                                                                                                                                                                                 | 每个入口在首次发布时成为 semver 承诺；以后新增是非破坏性的，删除是破坏性的               |
| OQ2  | 确认 `resources(...)` 等待准入（D3），修订 ADR 0006（`research/adr/0006-store-contract-and-providers.md:76-77`），并不再采用“仅保证先发起”的解读                                                                                                                                                                                                   | 批准                                                                                                                                                                                                                 | 五个示例的启动顺序；备选方案需要在每个基于连接的插头中提供就绪探针，并失去启动竞态的修复 |
| OQ3  | 确认 npm 名称与位置：`@go-like/connectrpc` 加 `./node`（备选 `@go-like/grpc`、`./native`）；`@go-like/file`（备选 `@go-like/fs`）；`@go-like/yaml`（备选 `@go-like/js-yaml`）；`@go-like/nats/jetstream`；插头绑定用 `<socket>/node`；consul、etcd、vault、kubernetes 设根入口；已批准的 `web`、`transport`、`transport/http` 名称成为 core 子路径 | 按[总设计](README.md)第 3.3 节批准                                                                                                                                                                                   | 包名发布后在 npm 上难以低成本更改；`protoc-gen-like` 的输出与 fixture 都跟随这些名称     |
| OQ4  | 批准 D43 的依赖种类规则及其表（对设计准则中“插头的第三方依赖一律为常规依赖”的修订）                                                                                                                                                                                                                                                                | 批准                                                                                                                                                                                                                 | 每个插头的安装行为；对 pino 或 OTel 使用常规依赖会使准入或桥接失效                       |
| OQ5  | 第三方插头的 core peer 策略，以及未被检测的 Bun 版本偏差                                                                                                                                                                                                                                                                                           | 一方插头精确锁步；推荐第三方插头使用 `^` 范围，并公开承诺：自 1.0 起，同一 major 内插座与 `/provider` 的声明只做增量变化；1.0 之前 `^0.x.y` 只接受补丁。模块求值时的检测器（D6）是运行时守卫；Bun 偏差接受并写入文档 | 外部插头会照抄文档最先写的写法                                                           |
| OQ6  | 重复 `traceparent` 策略，在发布关卡端到端测试（D37）之后决定                                                                                                                                                                                                                                                                                       | (a) 严格的 W3C 解析，加“不注册全局传播器”的配置规则，加 OTel 警告；若测试显示配置 B 中 `instrumentation-undici` 会追加头部，再考虑 (b) 取最后一个有效成员                                                            | 混合版本集群所依赖的线协议行为                                                           |
| OQ7  | 语义约定策略与 `rpc.system.name = "go_like"`                                                                                                                                                                                                                                                                                                       | 钉在 1.45.0；语义约定改名只在 major 版本中采纳；保留 `go_like`                                                                                                                                                       | 仪表盘与告警依赖这些名称                                                                 |
| OQ8  | 确认观测默认值：`completionLogs: "failures"`；观测层自己的停止预算；每个逻辑调用一个 CLIENT span；RPC 调用方错误带 `error.type`；未路由 RPC 的 span 名为 `go_like`；`messaging.system.name = "nats"`；缓存与存储不埋点                                                                                                                             | 全部按[总设计](README.md)第 5 章所述批准                                                                                                                                                                             | 输出量与告警形态；各项都只差一个选项或一个版本                                           |
| OQ9  | 没有日志处理器时的诊断回退（D38）                                                                                                                                                                                                                                                                                                                  | 在 `logEvent`/`recordEvent` 中集中回退：只输出 error 级、一行 JSON 写入 `console.error`、不含错误文本                                                                                                                | 没有观测的应用将看不到服务器、配置、心跳与任务的失败                                     |
| OQ10 | 把一致性用例集（`./testing`）作为公开 API 发布，标注“测试 API：minor 版本可增加用例”，并修订 ADR 0006（`research/adr/0006-store-contract-and-providers.md:81-82`）                                                                                                                                                                                 | 批准                                                                                                                                                                                                                 | 第三方插头作者运行这些用例；行为契约                                                     |
| OQ11 | gRPC/Connect 范围：(b) 作为位于 core 中间件与 `ServiceError` 模型之外的集成，写入文档（D23）；或 (a) 新增协议中立的策略中间件类型，加 `ServiceError` 与 Connect 的映射                                                                                                                                                                             | 现在选 (b)；当某个服务需要以 core 策略暴露 gRPC 时再做 (a)（目前没有使用者）                                                                                                                                         | 选 (b) 时，同时以两种协议暴露的服务需要两套策略栈                                        |
| OQ12 | RPC 契约保持只接受 `Struct`（`Endpoint<Request extends Struct>`）；Standard Schema 只由 config 接受                                                                                                                                                                                                                                                | 批准                                                                                                                                                                                                                 | 发布后最难撤回的 schema 决定                                                             |
| OQ13 | 在 `/job` 新增 `newPermanentJobError(cause)`（BullMQ 的 `UnrecoverableError`；内存队列不重试）                                                                                                                                                                                                                                                     | 新增：`examples/batch-reporting/src/processor.ts:27-29` 在不可重试的错误上耗尽三次尝试                                                                                                                               | 增量；`JobQueue` 契约多一条规则                                                          |
| OQ14 | 确认单实例检测器的键 `globalThis[Symbol.for("go-like.core.instances")]` 且没有关闭开关（D6），鉴于设计准则禁止以 `Symbol.for` 作身份品牌                                                                                                                                                                                                           | 批准：检测器的键不是身份品牌                                                                                                                                                                                         | 设计准则中一条必做项的措辞                                                               |
