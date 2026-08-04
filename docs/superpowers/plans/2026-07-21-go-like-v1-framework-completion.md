# go-like v1 微服务工具包完整落地实施计划

状态：历史计划。`@go-like/struct`、Handle、ResidentClient、Fetch Transport、ServiceDeclaration 与自动注册
组合器已经在首发前删除；当前公共契约以 `docs/developer-experience-alignment.md` 为准。

> **执行要求：** 按任务使用 TDD 红—绿—重构；每个生产切片完成后分别做规范符合性与代码质量审查。

**目标：** 按
`docs/superpowers/specs/2026-07-21-go-like-v1-framework-completion-design.md`
补齐内部 Server/Client/streaming、Store、Config、Registry provider、Selector、Broker/Event、OTel 与八语言文档，
并用真实 Docker 服务完成总验收。

**架构：** portable core 只保留结构式 SPI 与标准 Web API；provider 独立发布；所有 resident 能力接入
`@go-like/core` 生命周期；endpoint 声明同时驱动分派和注册；外部 Web 与内部 Transport 严格分层。

**技术栈：** TypeScript 7.0.2、Bun 1.3.14、Node 26.5.0、Deno 2.9.3、标准 Web API、Docker 29.6.1、
oxfmt 0.60.0、Changesets 2.31.1、VitePress 1.6.4。

## 全局约束

- 直接在 `/Users/munmunmiao/Documents/web/go-like` 的 dirty `main` 工作树实施。
- 不创建 worktree 或 feature branch；不 reset、不覆盖用户已有改动。
- 未经用户另行授权，不 `git add`、commit、push、PR、publish、release 或 deploy。
- 使用 `apply_patch` 修改文件；格式化工具产生的纯机械变更除外。
- 每项生产行为先写红测试，确认失败原因是目标能力缺失，再写最小实现。
- 每个任务开始前在 `/tmp/go-like-v1-task-N.before/` 保存 scope 文件与 SHA-256；完成后保存
  `.after/` 并用 `diff -ruN` 审查 untracked 文件。
- Context 是所有阻塞/I/O 方法的独立首参。
- 导出运行时值 lower camel case；业务函数与 callable type 有相邻 JSDoc。
- portable source 不静态 import `node:`、Bun、Deno 或供应商 SDK。
- 不新增 class、decorator、反射容器、全局默认实例或隐藏 retry。
- 新增 package 固定版本 `0.0.1`，并同步 workspace、tsconfig、tsdown、manifest、owner、inventory、
  published gates 与 Changeset。
- 外部服务行为不能用 mock 冒充；单元测试允许 fake 只用于确定性边界与故障注入。
- 每个 Docker suite 都先记录 container/network/volume baseline，结束后 fresh readback 必须完全恢复。
- 当前已知旧失败：`scripts/release-config.test.ts` 期待 28 workspace，真实为 29。Task 1 负责修复。

---

## Task 1：收敛仓库基线与 Struct bytes codec

**文件：**

- 修改：`scripts/release-config.test.ts`
- 修改：`packages/struct/src/codec/json.ts`
- 修改：`packages/struct/src/codec/index.ts`
- 修改：`packages/struct/src/codec/public_api.ts`
- 修改：`packages/struct/src/index.ts`
- 修改：`packages/struct/src/public_api.ts`
- 修改：`packages/struct/test/codec/json.spec.ts`
- 修改：`packages/struct/test/public-types.ts`
- 修改：`packages/struct/test/coverage-contract.ts`
- 修改：`packages/struct/test/runtime/published-runtime.fixture`
- 修改：`packages/struct/README.md`
- 创建：`.changeset/struct-json-bytes.md`

### Step 1：保存 before-tree

- [ ] 保存上述文件、`git status --short`、29 workspace 列表与现有失败日志。

执行记录：Task 1 代理未生成约定的 `/tmp` before-tree；此前主线程的只读命令输出保留了旧
`json.ts/public_api` 与 28/29 计数证据，但不得把缺失的 before snapshot 标记为完成。

### Step 2：写红测试

- [x] 在 `json.spec.ts` 增加 `jsonCodec(schema)` 的固定 UTF-8 vector、detached bytes、非法 UTF-8、非法
  JSON、schema mismatch、循环值测试。
- [x] 在 public types/runtime fixture 中消费 `Codec<T>` 与 `jsonCodec`。

```ts
const codec = jsonCodec(
  struct({
    id: struct.string(),
    count: struct.int()
  })
)

const bytes = codec.encode({ id: "订单-一", count: 1 })
expect(codec.decode(bytes)).toEqual({ id: "订单-一", count: 1 })
```

### Step 3：确认红灯

- [x] 运行：

```sh
bun test --isolate --no-orphans packages/struct/test/codec/json.spec.ts
bun run --filter @go-like/struct typecheck
```

- [x] 只接受缺少 `Codec/jsonCodec` 导致的红灯。

### Step 4：最小实现

- [x] 增加：

```ts
export interface Codec<T> {
  readonly mediaType: string
  encode(value: T): Uint8Array
  decode(bytes: Uint8Array): T
}
```

- [x] `jsonCodec` 固定使用 fatal UTF-8 decoder，object-level codec 继续复用。
- [x] 不增加 dependency 或 codec registry。
- [x] 把 release workspace 基线从 28 修正为当前真实 29；后续每个新增 package 任务同步更新精确计数，
  Task 14 只做 fresh 总回读，不让计数门禁长期保持红灯。

### Step 5：绿灯

- [x] 运行：

```sh
bun test --isolate --no-orphans packages/struct/test
bun run --filter @go-like/struct typecheck
bun run --filter @go-like/struct test:coverage
bun test --isolate --no-orphans scripts/release-config.test.ts
```

- [x] 审查 public export 只有 `Codec` 与 `jsonCodec` 两项新增。

---

## Task 2：补 App identity/hooks 与 readiness fail-closed

**文件：**

- 修改：`packages/core/src/app.ts`
- 修改：`packages/core/src/index.ts`
- 修改：`packages/core/test/app.test.ts`
- 修改：`packages/core/test/public-types.ts`
- 修改：`packages/core/test/coverage-contract.ts`
- 修改：`packages/core/README.md`
- 修改：`packages/health/src/registry.ts`
- 修改：`packages/health/test/registry.test.ts`
- 修改：`packages/health/README.md`
- 创建：`.changeset/core-app-hooks-health-readiness.md`

### Step 1：App 红测试

- [ ] 覆盖 id/name/version/metadata 防御性快照与 diagnostics。
- [ ] 覆盖四类 hook 的声明顺序。
- [ ] 覆盖 beforeStart failure 不启动 child。
- [ ] 覆盖 afterStart failure 逆序回滚。
- [ ] 覆盖 beforeStop/child/afterStop 多失败仍全部执行并按观察顺序聚合。
- [ ] 覆盖 stop caller cancellation 不取消 shared drain。
- [ ] 覆盖 startup hooks 使用 start Context，stop hooks 使用从 drain 开始计时的 shared absolute deadline。
- [ ] 覆盖 hook phase/index/status/error diagnostics。

### Step 2：Health 红测试

- [ ] 固定：

```ts
expect((await probes.check(background(), "live")).ok).toBe(true)
expect((await probes.check(background(), "ready")).ok).toBe(false)
```

### Step 3：确认红灯并实现

- [ ] 运行 targeted tests，确认旧实现语义不满足。
- [ ] 在现有 App state machine 内加入 immutable identity 与四个 hook 队列；不写第二套生命周期。
- [ ] readiness 只改空集合结果，不改变 probe 并发、timeout、错误脱敏。

### Step 4：绿灯

- [ ] 运行：

```sh
bun test --isolate --no-orphans packages/core/test packages/health/test packages/web/test/health.test.ts
bun run --filter @go-like/core typecheck
bun run --filter @go-like/health typecheck
bun run --filter @go-like/core test:coverage
bun run --filter @go-like/health test:coverage
```

---

## Task 3：ServiceError、内部 unary Server 与自动注册

**文件：**

- 修改：`packages/transport/src/types.ts`
- 修改：`packages/transport/src/errors.ts`
- 修改：`packages/transport/src/index.ts`
- 修改：`packages/transport/src/headers.ts`
- 修改：`packages/transport/test/errors.test.ts`
- 修改：`packages/transport/test/public-types.ts`
- 修改：`packages/client/src/index.ts`
- 修改：`packages/client/test/client.test.ts`
- 新建：`packages/server/package.json`
- 新建：`packages/server/{LICENSE,README.md,bunfig.toml,tsconfig.json,tsconfig.test.json}`
- 新建：`packages/server/{capability.json,owner.json}`
- 新建：`packages/server/src/index.ts`
- 新建：`packages/server/test/{server,public-api,package-contract,source-policy}.test.ts`
- 新建：`packages/server/test/{public-types,coverage-contract}.ts`
- 修改：`tsconfig.base.json` 与 root TypeScript project references
- 修改：`scripts/release-config.test.ts`
- 修改：`test/repository-contract.test.ts`
- 修改：`tools/manifests/capability-vocabulary.ts`
- 修改：`tools/manifests/validate.test.ts`
- 修改：published business case、package/count/export inventory 与 runtime/type fixtures
- 修改：`README.md`、`docs/file-inventory.md` 与必要 package inventory
- 修改：`e2e/scripts/registry-transport-consul-docker.ts`
- 修改：联合 E2E case、suite inventory 与 contracts
- 创建：`.changeset/server-auto-registration.md`

### Step 1：ServiceError 红测试

- [ ] 固定 code/status/metadata snapshot。
- [ ] 固定 `name: "ServiceError"`、package-private brand 与 `isServiceError()`，同形伪造对象必须拒绝。
- [ ] 未知 error 序列化为固定 internal payload。
- [ ] `internalServiceError()` 固定为 `internal` / `internal service error` / 500 / 空 metadata。
- [ ] `encodeServiceError(kind, error)` 与 `decodeServiceError(kind, carrierStatus, ...)` 是唯一 canonical
  wire helper；同一 200 carrier 在 unary 合法、在 Fetch status mismatch 时失败。
- [ ] bounded body/header 超限 fail closed。
- [ ] HTTP 200 带 error wire 与 HTTP non-2xx 都能形成稳定 `ServiceError`。
- [ ] 固定新增 marker/code/status headers、canonical JSON schema、8192-byte body 上限与 malformed 优先级。
- [ ] 既有 `Go-Like-Error` 继续只表示 Transport protocol diagnostic。

### Step 2：Server 红测试

- [ ] 声明 validation 在 I/O 前完成。
- [ ] header 查找大小写不敏感。
- [ ] service/endpoint 精确 dispatch；未知路由不调用 handler。
- [ ] header 名大小写不敏感，service/endpoint 值大小写敏感。
- [ ] 同一 endpoint 数组生成精确 Registry `Endpoint[]`。
- [ ] middleware 声明顺序明确。
- [ ] `composeUnary(handler, a, b)` 精确形成 `a(b(handler))`，非函数 middleware 在 bind 前拒绝。
- [ ] handler throw 经过 ServiceError sanitization。

### Step 3：自动注册红测试

- [ ] 使用结构式 fake 只验证顺序：

```text
server.start
registration.start
registration.stop
server.stop
```

- [ ] registration start failure 必须触发 server rollback。
- [ ] deregistration failure 不能跳过 server drain。
- [ ] bind 前声明只含 node id/metadata；registration source 在 admission 后默认生成
  `addresses: [server.address()]`。
- [ ] 固定 advertise address 与 async advertise resolver 都在 bind 后、Registry I/O 前执行。
- [ ] advertise 保持 Registry transport-opaque string，不猜 scheme；空/重复/非法 resolver 结果 fail closed，
  并回滚已绑定 server。
- [ ] 绑定 unspecified/container/NAT 地址的 E2E 必须显式 advertise override，不能注册不可达 bound address。

### Step 4：最小实现

- [ ] `@go-like/server` 只组合 `server()`、`registration()`、`AddressServer` 和 declaration。
- [ ] registered helper 返回 `ReturnType<typeof lifecycleServer>`；Core `AppOption` 继续不公开。
- [ ] 不复制 App state machine。
- [ ] Client 加普通函数 middleware option，并在 response wire 上识别 ServiceError。
- [ ] middleware 第一个声明最外层；基础 call 无 retry，显式 middleware 对零次/多次 next 负责。
- [ ] selector feedback 仅将 dial/send/recv、TransportProtocolError 与无 marker HTTPStatusError 记为失败；
  成功、ServiceError、internal ServiceError、caller cancellation/deadline 均反馈 `error: null`。
- [ ] 不加 retry、pool、reflection 或默认 router。

### Step 5：真实 Consul + HTTP 联合 E2E

- [ ] 将现有手工 endpoint `Call` 修成由 `Orders.Get` 同一声明生成。
- [ ] 覆盖：

```text
real bind -> register -> discover -> select -> Fetch call
registration failure -> bound port rollback
stop -> Registry empty -> port rebind
```

- [ ] 使用 Consul 2.0.2 fixed digest，不得退回内存 Registry。

### Step 6：绿灯

- [ ] 运行 package tests、coverage、typecheck、published smoke 与联合 Docker suite。
- [ ] 新 package 后精确锁定 30 workspaces / 26 public packages / 4 examples / 44 public export keys。
- [ ] fresh 检查 Consul records、容器、网络、端口和进程归零。

---

## Task 4：标准 Fetch Transport 与 streaming Client/Server

**文件：**

- 修改：`packages/transport/src/types.ts`
- 修改：`packages/transport/src/index.ts`
- 修改：`packages/transport/test/public-types.ts`
- 修改：`packages/transport/http/src/types.ts`
- 修改：`packages/transport/http/src/server.ts`
- 修改：`packages/transport/http/src/transport.ts`
- 修改：`packages/transport/http/src/index.ts`
- 修改：`packages/transport/http/src/node.ts`
- 新建或修改：`packages/transport/http/src/fetch.ts`
- 修改：`packages/transport/http/test/{server,transport,public-types}.test.ts`
- 修改：`packages/transport/http/test/e2e/native-e2e.ts`
- 修改：`packages/client/src/index.ts`
- 修改：`packages/client/test/client.test.ts`
- 修改：`packages/server/src/index.ts`
- 修改：`packages/server/test/server.test.ts`
- 创建：`.changeset/fetch-streaming.md`

### Step 1：SPI 红测试

- [ ] 类型门禁要求 `TransportFetchHandler`、`FetchTransport`、`StreamClient`，不与 `@go-like/web` 的
  单参数 Handler 混名。
- [ ] unary `Message.body` 必须仍为 `Uint8Array`。

### Step 2：HTTP direct handler 红测试

- [ ] 使用现有 HTTPHost fixture 证明 direct Fetch server：

  - 不经过 unary Socket body buffering；
  - 首 chunk 在第二 chunk 生成前抵达；
  - Response status/headers 保留；
  - request abort 进入 go-like Context；
  - graceful stop 等待 active stream；
  - hard force 取消 reader 并释放端口。

### Step 3：Stream Client 红测试

- [ ] request factory 仅选择成功后调用一次。
- [ ] Request URL 必须精确等于 selected target。
- [ ] reserved routing headers 在 Fetch 前拒绝。
- [ ] factory 签名为 `(target, signal) => Request`；Client 接管 unused/unlocked one-shot Request，原地设置
  header，不 clone/tee streaming body。
- [ ] 不可变 headers 在 Fetch 前 fail closed，调用方不得在 factory 返回后复用 Request。
- [ ] response headers 到达后 selection feedback 恰好一次。
- [ ] selection 后的 factory/validation failure、caller cancellation、Fetch reject、invalid Response 与
  TransportProtocolError 每条出口都精确 feedback 一次；仅非 caller 引起的 Fetch/protocol failure
  计入 selector error。
- [ ] 任意标准 Response headers（含 non-2xx/ServiceError）反馈 `error: null`，Stream Client 不把 Fetch
  status 改写成 exception。
- [ ] Client 不获取 reader、不包装 Response、不观察 body terminal；body/backpressure/cancel 由调用方与注入
  Request signal 拥有。
- [ ] transport failure 不自动选择第二节点。

### Step 4：最小实现

- [ ] 从 `newHTTPServerFromOptions` 抽取私有 HTTPHost lifecycle kernel，供 unary 与 Fetch adapter 使用。
- [ ] `newHTTPFetchTransport` 只调用注入标准 Fetch，并将 Context 连接到 Request signal。
- [ ] Stream Client 原样返回标准 Response；不预读、不缓存、不包装 body。
- [ ] Node streaming request 文档明确 `duplex: "half"`，公共 portable API 不增加 Node 私有字段。

### Step 5：真实 runtime E2E

- [ ] Node 26.5.0、Bun 1.3.14、Deno 2.9.3 均验证 response incremental stream。
- [ ] Node 使用真实 `duplex: "half"` 验证 upload stream。
- [ ] 覆盖 upload 增量到达、Node 缺失 duplex 拒绝、request cancel、never-consumed response、显式 body
  cancel、backpressure、headers-scoped feedback、server stop、hard force、端口 rebind。

### Step 6：绿灯

- [ ] 运行 Transport、HTTP、Client、Server 全部 targeted tests、coverage、typecheck 与 runtime smoke。

---

## Task 5：Selector 策略

**文件：**

- 修改：`packages/registry/src/selector.ts`
- 修改：`packages/registry/src/types.ts`
- 修改：`packages/registry/src/index.ts`
- 修改：`packages/registry/test/selector.test.ts`
- 修改：`packages/registry/test/public-types.ts`
- 修改：`packages/registry/test/coverage-contract.ts`
- 修改：`packages/registry/README.md`
- 创建：`.changeset/registry-selectors.md`

### Step 1：Random 红测试

- [ ] 注入固定 random 序列并证明边界 `0 <= value < 1`。
- [ ] 每次 select 精确调用 random 一次，并按 `floor(value * n)` 选稳定排序 endpoint。
- [ ] 非有限、负数、1 或更大的 random 结果 fail closed 且不推进状态。

### Step 2：Weighted RR 红测试

- [ ] 权重 5:1 的六次选择固定为五次 A、一次 B。
- [ ] 5:1 精确顺序为 `A,A,A,A,A,B`，membership 变化保留 surviving endpoint 当前槽位。
- [ ] 非正整数、异常 weight callback 在选择前失败。

### Step 3：P2C 红测试

- [ ] 固定 random 两候选，低 in-flight 胜出。
- [ ] done 恰好一次递减，重复调用不变。
- [ ] 默认 threshold=3/cooldown=10_000ms；连续错误触发 cooldown，成功重置。
- [ ] 全 cooldown 选择最早恢复者。
- [ ] 单 eligible candidate 不读 random；两候选按固定无重复抽样公式，in-flight 平局取第一样本。
- [ ] invalid random/clock/options fail closed 且不推进 state。
- [ ] service domain state 上限 1024，无 timer。

### Step 4：实现与绿灯

- [ ] 复用 snapshot、domain、endpoint identity helper，不建立 selector framework。
- [ ] 运行 registry 全测试、coverage、published types/runtime 和 discovery-client 联合单测。

---

## Task 6：Store core 与 File provider

**文件：**

- 新建：`packages/store/` 完整 package shell
- 新建：`packages/store/src/{types,options,errors,snapshot,testing,index}.ts`
- 新建：`packages/store/test/*`
- 新建：`packages/store/file/` 完整 package shell
- 新建：`packages/store/file/src/{types,store,index,node-host,node}.ts`
- 新建：`packages/store/file/test/*`
- 修改：root workspace、tsconfig paths/build、tsdown entry
- 修改：manifest vocabulary/schema
- 创建：`.changeset/store-core-file.md`

### Step 1：Store conformance 红测试

- [ ] 固定 read missing、write/read copy、overwrite revision、delete、prefix、sort、limit/cursor、TTL、CAS、
  Context cancellation、capabilities 与 stable errors。
- [ ] conformance 接受 provider factory，不自带全局实例。
- [ ] Store 构造不 I/O；start 前/stop 后操作失败；start/stop/done 与 passive failure 对齐 Core Server。

### Step 2：Core 最小实现

- [ ] 只实现 types/options/errors/snapshot/testing。
- [ ] value/metadata/page 深拷贝并冻结。
- [ ] option reducer 声明顺序 last-wins。

### Step 3：File 红测试

- [ ] 真实临时目录覆盖：

  - atomic temp/rename；
  - restart recovery；
  - corrupt snapshot fail closed；
  - stale temp 忽略；
  - path traversal 不可能；
  - concurrent in-process write 串行；
  - CAS、TTL、pagination；
  - canceled operation 不写盘。

### Step 4：File 实现

- [ ] root 接受 injected filesystem host，`./node` 才 import `node:fs`；`start(ctx)` 读取并验证快照。
- [ ] schema version、checksum、revision 单调。
- [ ] capability 声明 `sharedWriters: false`。

### Step 5：绿灯

- [ ] Bun/Node/Deno 跑 portable root；Node 跑真实 filesystem。
- [ ] 两包 100% coverage、typecheck、packed smoke、manifest 和 source policy。

---

## Task 7：Consul/etcd Store、YAML 与 etcd Config

**文件：**

- 新建：`packages/store/consul/` 完整 package
- 新建：`packages/store/etcd/` 完整 package
- 新建：`packages/config/src/yaml.ts`
- 修改：`packages/config/package.json` exports/dependency
- 修改：`packages/config/src/index.ts`
- 新建：`packages/config/etcd/` 完整 package
- 新建：对应 unit、conformance、Docker E2E 与 reports
- 修改：e2e inventory/suites/contracts
- 创建：`.changeset/stateful-store-config-providers.md`

### Step 1：YAML 红测试

- [ ] map/array/scalar child、Unicode、timestamp string。
- [ ] object root 之外、多文档、duplicate key、custom tag、alias cycle、unsafe key、BigInt、non-finite 失败。
- [ ] decoder failure 不改变 Config last-good。

### Step 2：YAML 实现

- [ ] 精确依赖 `yaml: 2.9.0`。
- [ ] 复用 `fileSource(..., { decode: decodeYaml })`，不复制 watcher。

### Step 3：Consul Store unit/conformance

- [ ] request shape、base64、ModifyIndex、CAS、recurse、session TTL、ACL redaction、uncertain readback。
- [ ] 跑 `@go-like/store/testing` 全 conformance。

### Step 4：etcd Store 与 Config unit/conformance

- [ ] JSON gateway base64/range_end/txn/lease/watch stream/compaction decode。
- [ ] Store CAS 与 TTL。
- [ ] Config exact key initial range、revision+1 watch、delete、compaction relist、last-good。

### Step 5：真实 Docker

- [ ] Consul 2.0.2：CRUD/prefix/CAS/session TTL/ACL/restart/零 KV 与 session。
- [ ] etcd
  `gcr.io/etcd-development/etcd:v3.7.0@sha256:6ecefbe2510c4a30573a62a4d6dd175acf881ca67003fcd91849a16df7a724d5`：
  CRUD/prefix/txn/lease、Config update/delete、forced compaction、restart、auth（若 capability
  声明）、零 key/lease/client。
- [x] 本机 `linux/arm64` 已真实 pull 并固定 RepoDigest；`/health` 返回 200 与 `health:true`，预检资源已清零。

### Step 6：绿灯

- [ ] 四个 package/subpath 全测试、coverage、typecheck、runtime matrix、published smoke。

---

## Task 8：etcd Registry

**文件：**

- 新建：`packages/registry/etcd/` 完整 package
- 新建：unit、conformance、runtime、Docker E2E 与 report
- 修改：root workspace/build/paths/manifests/inventory/e2e
- 创建：`.changeset/registry-etcd.md`

### Step 1：红测试

- [ ] logical key、canonical payload、token lease、duplicate publisher、identity collision、service conflict。
- [ ] transaction lost-response exact readback。
- [ ] keepalive、watch create/update/delete、compaction relist、restart。
- [ ] stop 只清自己的 token，最后 token 删除 key。

### Step 2：实现

- [ ] 使用标准 Fetch JSON gateway，不引入 gRPC/Protobuf client。
- [ ] 复用 Registry canonical 与 provider conformance。
- [ ] owner watcher、lease keepalive 与 stop/done 语义对齐现有 Consul provider。

### Step 3：真实 Docker

- [ ] 使用已预检的 etcd 3.7.0 fixed digest。
- [ ] 完整 conformance。
- [ ] `SIGKILL` publisher 后等待 lease expiry。
- [ ] compaction、restart、gateway outage/recovery。
- [ ] key、lease、watch、client、container/network 零残留。

### Step 4：绿灯

- [ ] package coverage、typecheck、runtime、published 和 E2E 全过。

---

## Task 9：Kubernetes EndpointSlice Registry

**文件：**

- 新建：`packages/registry/kubernetes/` 完整 package
- 新建：EndpointSlice codec、Fetch client、watch/relist、registry
- 新建：unit/conformance/K3s Docker E2E
- 新建：最小 Role/RoleBinding/namespace fixture
- 修改：root workspace/build/paths/manifests/inventory/e2e
- 创建：`.changeset/registry-kubernetes.md`

### Step 1：Codec 红测试

- [ ] Unicode service/node identity 使用 hash name/label，原文在 annotation 无损 round trip。
- [ ] addressType/port 可表达性 validation。
- [ ] canonical payload/hash/token set。
- [ ] foreign/managed schema 区分。

### Step 2：CAS 与 watcher 红测试

- [ ] create/update/delete 使用 resourceVersion。
- [ ] 两个 client 同 node token 合并；停止单 token 不删 Slice。
- [ ] list 聚合多 Slice。
- [ ] watch event 与 `410 Gone` relist diff。
- [ ] namespace、label selector、foreign slice 隔离。

### Step 3：实现

- [ ] 使用标准 Fetch；不增加 `@kubernetes/client-node`。
- [ ] 只访问 discovery.k8s.io/v1 EndpointSlice。
- [ ] bearer token 与 API error secret-safe。

### Step 4：真实 K3s Docker

- [ ] 使用
  `rancher/k3s:v1.36.2-k3s1@sha256:6a47cea22c4b834d4ba72c89d291696b79ebe406251f90b446e4dff03513dd87`。
- [x] privileged 单节点 harness 已在本机预检：容器内 `/bin/kubectl` + admin kubeconfig 调用 `/readyz`
  返回 `ok`；只证明 API ready，不把尚未出现的 Node 冒充 Ready。
- [ ] 最小 namespace Role/RoleBinding 成功。
- [ ] 逐项移除权限得到稳定 forbidden。
- [ ] 人工制造 stale RV/410，证明 relist/re-watch。
- [ ] foreign Slice 不变，publisher kill 后 owner cleanup/expiry 路径可观察。
- [ ] namespace、RBAC、Slice、container、network、volume 全清。

### Step 5：绿灯

- [ ] conformance、coverage、typecheck、packed runtime 与真实 K3s E2E 全过。

---

## Task 10：ZooKeeper Registry

**文件：**

- 新建：`packages/registry/zookeeper/` 完整 package
- 新建：path codec、native client adapter、watch/reconcile、registry
- 新建：unit/conformance/Node-Bun runtime/Docker E2E
- 修改：root workspace/build/paths/manifests/inventory/e2e
- 创建：`.changeset/registry-zookeeper.md`

### Step 1：红测试

- [ ] Unicode identity path encoding、payload/hash、ephemeral token children。
- [ ] duplicate publisher、identity/service conflict。
- [ ] one-shot watch re-arm、periodic reconcile、session expiration/reconnect。
- [ ] ACL/auth redaction与 stable terminal。

### Step 2：实现

- [ ] 精确依赖 `node-zookeeper-client: 1.1.3` 与对应 types。
- [ ] 该 package 明确只声明 Node/Bun runtime。
- [ ] 公共 Registry 类型继续来自 `@go-like/registry`。

### Step 3：真实 Docker

- [ ] 使用
  `zookeeper:3.9.5@sha256:4c6f15fbd5491a3e01b0108c046891125553329a4956848ba3014cedff5386ee`。
- [x] 本机预检开启 `ZOO_4LW_COMMANDS_WHITELIST=ruok` 后返回 `imok`，版本 3.9.5，临时资源清零。
- [ ] 完整 conformance。
- [ ] publisher `SIGKILL` 后 ephemeral 消失。
- [ ] session expiry、watch re-arm、ACL 与 reconnect。
- [ ] znode、session、client、container、network、volume 零残留。

### Step 4：绿灯

- [ ] Node/Bun package gates 与 Docker E2E 全过；不得声称 Deno 支持。

---

## Task 11：Broker、Event 与 NATS typed provider

**文件：**

- 新建：`packages/broker/` 完整 package
- 新建：`packages/event/` 完整 package
- 修改：`packages/nats/package.json`
- 新建：`packages/nats/src/broker.ts`
- 新建：`packages/nats/src/jetstream-broker.ts`
- 修改：`packages/nats/src/index.ts`
- 修改：`packages/nats/src/jetstream.ts`
- 新建或修改：NATS public API/types/package/source-policy/coverage tests
- 修改：NATS Core 与 JetStream Docker E2E
- 修改：root workspace/build/paths/manifests/inventory
- 创建：`.changeset/broker-event-nats.md`

### Step 1：Broker SPI 红测试

- [ ] immutable headers/body、Context-first publish/subscribe、stable subscription done/stop。
- [ ] generic native event/result types通过 public typecheck。
- [ ] Broker core 不出现 ack/nack 方法。
- [ ] `subscription(...)` 只把一次订阅接入 Core Server 生命周期，不拥有 Broker connection。

### Step 2：Event 红测试

- [ ] typed publish 使用 `Codec<T>`。
- [ ] decode 延迟执行。
- [ ] decode schema failure 后 native event identity 仍可取得。
- [ ] bytes 防御性复制。
- [ ] typed subscribe 返回底层 `BrokerSubscription`，合法/非法 payload 均保留 native event。
- [ ] `eventSubscription(...)` 将 typed subscribe/stop/done 接入 Core Server 生命周期，不拥有底层 connection。

### Step 3：NATS 实现

- [ ] `@go-like/nats/broker`：
  - publish 返回 `void`；
  - event native 是官方 `Msg`；
  - 不伪造 ack。
- [ ] `@go-like/nats/jetstream/broker`：
  - publish 返回原生 `PubAck`；
  - event native 是官方 `JsMsg`；
  - ack/nak/term/working 仍直接由官方对象提供。
- [ ] 复用现有 NATS lifecycle，不写第二套 subscription drain。

### Step 4：真实 NATS

- [ ] NATS Server 2.14.3 fixed digest。
- [ ] Core typed round trip、queue group、unsubscribe/drain。
- [ ] JetStream PubAck、合法 event `ackAck`。
- [ ] 非法 schema 后应用显式 `nak` 与 `term` 两条路径。
- [ ] stream/consumer/subscription/connection/container 零残留。

### Step 5：绿灯

- [ ] Broker/Event/NATS coverage、typecheck、published runtime/types、Docker E2E 全过。

---

## Task 12：OpenTelemetry 显式 instrumentation

**文件：**

- 新建：`packages/otel/src/client.ts`
- 新建：`packages/otel/src/server.ts`
- 新建：`packages/otel/src/broker.ts`
- 修改：`packages/otel/src/index.ts`
- 修改：`packages/otel/package.json`
- 新建或修改：OTel wrapper tests/public types/coverage
- 修改：`packages/otel/test/e2e/docker-e2e.ts`
- 修改：`packages/otel/test/e2e/collector.yaml`
- 更新：fresh Collector report
- 创建：`.changeset/otel-instrumentation.md`

### Step 1：传播实验

- [ ] 在测试中使用官方 SDK 与 Context Manager 证明：

```text
client span
→ injected W3C headers
→ server extracted child span
→ broker publish span
→ consumer linked/child span
```

- [ ] 若官方 Context Manager 在某 runtime 不保持 async active context，该 runtime 必须明确 unsupported，不做
  假 span。

### Step 2：wrapper 红测试

- [ ] caller headers 保留，trace headers由 propagator 管理。
- [ ] stable span names/low-cardinality attributes。
- [ ] cancellation、ServiceError、transport error 分类。
- [ ] exporter/provider/context manager 仍由应用拥有。

### Step 3：最小实现

- [ ] `traceClient` 返回结构式 Client wrapper。
- [ ] `traceUnaryMiddleware` 返回普通 Server middleware。
- [ ] `traceBroker` 返回结构式 Broker wrapper。
- [ ] 不增加自动 instrumentation、global provider 或 exporter config。

### Step 4：真实 Collector + NATS + HTTP

- [ ] Collector 0.156.0 fixed digest。
- [ ] 真实 Client → HTTP → Server trace parent/child。
- [ ] 真实 NATS publish/consume trace。
- [ ] metrics/exporter outage/recovery 与 shutdown flush。
- [ ] collector received payload 由测试查询/文件 exporter形成证据。

### Step 5：绿灯

- [ ] OTel coverage、typecheck、published smoke、Docker E2E 与资源清理全过。

---

## Task 13：VitePress 八语言文档

**文件：**

- 修改：`package.json`
- 修改：`bun.lock`
- 修改：`.gitignore`
- 修改：`scripts/verify-workspace.ts`
- 新建：`doc/.vitepress/config.ts`
- 新建：`doc/index.md` 与 9 个默认英文子页
- 新建：7 个 locale 目录，各 10 个同路径页面
- 新建：`test/doc-site.test.ts`
- 修改：`README.md`
- 创建：`.changeset/vitepress-docs.md`

### Step 1：配置与 parity 红测试

- [ ] 精确断言 VitePress 1.6.4 与四个 root scripts。
- [ ] 断言 8 locale tags 都含 script subtag。
- [ ] Arabic `dir: rtl`。
- [ ] 每个 locale 相对路径集合一致。
- [ ] TW/HK/简中正文互不相同。
- [ ] VitePress dead link 为 build error。

### Step 2：最小依赖

- [ ] 只加 `vitepress: 1.6.4`，不直接加 Vue/vue-i18n/plugin。
- [ ] 默认 SPA，不设置 `mpa: true`。
- [ ] local search 和 UI labels 为八 locale 本地化。

### Step 3：内容

- [ ] 每个 locale 完成：
  - getting started；
  - architecture；
  - service call；
  - streaming；
  - config/registry/store；
  - broker/events；
  - health/observability；
  - packages reference；
  - verification。
- [ ] 台湾使用台湾开发者常用词；香港使用自然繁体粤语书面表达；不做机械简繁转换。
- [ ] 其他语言使用自然、直接的开发者语气。

### Step 4：绿灯

- [ ] 运行：

```sh
bun test test/doc-site.test.ts
bun run doc:build
bun run verify:doc
```

- [ ] 检查生成 HTML 的 `lang`、Arabic `dir`、locale switch 与 client navigation。

---

## Task 14：仓库契约、文档与最终总验收

**文件：**

- 修改：`package.json` workspace（目标 40）
- 修改：`tsconfig.base.json`
- 修改：`tsconfig.build.json`
- 修改：`tsdown.config.ts`
- 修改：`scripts/verify-workspace.ts`
- 修改：`scripts/release-config.test.ts`
- 修改：`tools/manifests/capability-vocabulary.ts`
- 修改：`schemas/capability-manifest.schema.json`
- 修改：`docs/file-inventory.md`
- 修改：`docs/capability-comparison.md`
- 修改：`docs/adr/0004-service-registry-and-selection.md`
- 新建或修改：Store/Broker/Server 相关 ADR
- 修改：`README.md`
- 修改：`.changeset/README.md`
- 修改：repository contracts、published package counts、E2E inventory counts

### Step 1：逐项审计

- [ ] 对照总设计第 20 节，列出每一项对应源文件、测试与真实报告。
- [ ] 任何缺少 source/test/runtime 三项之一的能力不得标记完成。

### Step 2：同步仓库精确契约

- [ ] 用工具 fresh 生成：

```text
36 public packages
4 private examples
40 workspaces
exact package exports
exact source/test inventories
exact E2E case/suite counts
```

- [ ] 不手工猜计数。
- [ ] 更新 capability/owner vocabulary 与所有 package manifests。
- [ ] 更新 file inventory，确保 dist/.artifacts 不进入源码清单。

### Step 3：targeted 总回归

- [ ] 逐包运行 typecheck/test:coverage/published smoke。
- [ ] 对失败先区分既有、当前任务和环境，不降低断言迎合错误。

### Step 4：真实 Docker 总回归

- [ ] 顺序运行所有 fixed-digest suite：

```text
Consul
etcd
K3s
ZooKeeper
NATS Core/JetStream
Redis/BullMQ
OpenTelemetry Collector
mDNS
HTTP/streaming
combined registration/call
```

- [ ] 每个 suite 前后 snapshot Docker inventory。
- [ ] 最终 `docker ps -a`、network、volume 与项目进程均无 go-like 残留。

### Step 5：仓库总门禁

- [ ] 按顺序 fresh 运行并保存退出码：

```sh
bun run fmt
bun run fmt:check
bun run verify:workspace
bun run verify:manifests
bun run verify:file-inventory
bun run typecheck
bun run build
bun run test:coverage
bun run test:coverage:workspaces
bun run test:examples:node
bun run test:published
bun run verify:doc
bun run test:e2e:prepared
bun run verify
git diff --check
git status --short --branch
```

- [ ] 命令仍在运行、失败、超时或输出被截断时不得声明通过。

### Step 6：独立审查

- [ ] 规范符合性审查：逐条核对总设计。
- [ ] 代码质量审查：公共 API、ownership、Context、错误身份、安全、复杂度。
- [ ] 最终 broad review：检查整个 dirty tree，不只检查 `git diff`。
- [ ] 修复所有阻断意见并重跑受影响门禁。

### Step 7：完成报告

- [ ] 中文交付：
  - 架构与包清单；
  - 新能力与明确未支持边界；
  - fresh 测试/coverage/build/Docker 结果；
  - 已知限制；
  - 工作区状态。
- [ ] 不 commit、push、publish 或 deploy。
