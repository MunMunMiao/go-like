# ADR 0004：服务注册、服务发现与端点选择

日期：2026-07-19

状态：公共契约已被替代

> 本 ADR 记录早期 Service/Node/RegistrationHandle 方案，不再是当前 Registry 用户体验。
> 当前只发布 Kratos 风格 `Registrar`、`Discovery`、`Registry`、`Watcher` 与 `ServiceInstance`；
> 迁移基线见
> [`../developer-experience-alignment.md`](../developer-experience-alignment.md)。

## 背景

go-kratos、go-zlab/go-kratos 与 go-micro 都把服务注册和服务发现作为独立能力。LikeGo 已有配置中心，但
配置 watch 不能替代服务注册、TTL、passing health、catalog、局域网发现或端点选择。

Registry 还必须与 Transport 解耦：服务发现提供事实，应用通过显式 resolver 决定如何把 Service/Node
转换为可调用 endpoint。Registry 不猜测 HTTP scheme，也不负责发起请求、重试 body 或隐藏调用失败。

## 决策

### 公共 Registry 契约

`@likego/registry` 只依赖标准 ECMAScript 与 Web API，定义：

- 不可变 `Value`、`Endpoint`、`Node`、`Service` 与 raw `Result`；
- `Registry`、`Registrar`、`Watcher`、`RegistrationHandle` 与 capability snapshot；
- 注册、查询、列表、watch、discovery 的同步 functional options；
- `registration(...)` lifecycle Server；
- 显式 `ServiceInstanceResolver`、`discovery(...)` 与可替换 Selector；
- provider-neutral conformance suite。

所有阻塞操作把 `Context` 作为独立首参。构造与 `init(...)` 不启动资源；一次 register/watch 返回的 handle
拥有独立 owner Context 和稳定 `done()`。公共 `deregister()` 不存在，避免与 `RegistrationHandle.stop()`
形成双 owner。

### Canonical 内容与 identity

Service、Node、Endpoint、Value 和 metadata 在 provider boundary 做防御性快照。metadata 按 Unicode code
point 排序；声明顺序有语义的 Node addresses、Endpoint 和递归 Value 保持原顺序。

公共包提供三种 SHA-256 Base32 identity：

- service content：不包含 nodes，用于判断同 name/version 的 Service 声明是否一致；
- identity content：包含一个完整 Node，用于判断 cooperating publisher 是否发布相同内容；
- logical identity：只包含 name、version、node ID，用于稳定 wire 标识。

压缩格式不参与 semantic hash。provider 对受管 wire 的缺段、重复段、hash mismatch、identity collision 或
同 name/version content conflict 必须 fail closed；foreign record 可以忽略，不能把损坏受管记录伪装为空。

### 生命周期所有权

- 应用拥有 Service 声明、resolver、注入的 Fetch、mDNS host factory 和外部 Consul 进程。
- `RegistrationHandle` 唯一拥有本次注册的 token、远端记录、heartbeat、timer 与回滚责任。
- `Watcher` 唯一拥有 provider cursor/socket、retry/resync timer、buffer 和 pending consumer waits。
- `next(ctx)` 的 Context 只限制当前 consumer wait，不停止 owner watcher。
- 第一次 `stop(ctx)` 启动唯一 owner cleanup；后续调用加入同一 cleanup，每个 Context 只限制自身等待。
- `done()` 始终返回同一个 terminal barrier。timeout 只结束 owner waiter，不得冒充底层已终止。
- watcher 被动失败时先阻止新事件并取消 owner，再等待已接纳的 response body、cursor/socket、timer 与 session
  完成释放，最后才以原始失败 settle `done()`；错误可见性不能越过资源终态。
- 原生 `Error` 保留 identity；多个独立 cleanup failure 按观察顺序聚合。

### Consul provider

`@likego/registry-consul` 使用应用注入的标准 Fetch 调用 Consul Agent HTTP API，不依赖 Node Consul SDK。

- 每次 register 生成独立 256-bit token；远端 ID 同时包含 logical identity 与 token。
- 同 identity 的 generation 使用栈语义：停止 non-current handle 不改远端；停止 current handle 恢复前一份
  不可变 snapshot；最后一份停止才删除。
- 多 Node mutation 按 identity 排序串行化，失败时按接受顺序逆向 rollback。
- 注册、pass、deregister 的不确定响应通过 exact Agent readback 判断，不根据异常类型猜测结果。
- `getService` 只使用 passing health；`listServices` 返回 name-only catalog；watch 使用 blocking index、
  coalesce、退避与完整 snapshot diff。
- HTTP redirect 固定为 fail closed，ACL token 不得被转发到第二 origin，也不得进入错误图或 diagnostics。

### mDNS provider

`@likego/registry-mdns` 根入口实现 portable DNS/TXT codec、cache、registration 和 watcher；生产图不引入
Node-only mDNS SDK。应用注入结构式 `MDNSHost`，一个 family/interface 对应一个 datagram owner。

- wire 使用独立的 LikeGo service namespace 与 `Likego-` TXT 字段；
- payload 使用 canonical UTF-8 JSON、deflate+base64url、连续 chunk 与 hash 校验；
- packet、TXT、decode、Value depth/node count 都有固定上限；
- probe、announce、refresh、query、TTL0 goodbye、crash expiry 和 cooperating responder rescue 都由同一
  portable 状态机实现；
- `@likego/registry-mdns/node` 隔离 `node:dgram`、网卡枚举、wildcard bind、membership 与 multicast
  interface 选择；Node host 不进入 portable 根入口。

Node host 的 socket 映射以真实平台行为为准：IPv4/IPv6 multicast 使用 wildcard bind，再按接口加入组播；
`reuseAddr` 是跨平台要求，`reusePort` 不是硬前置，因为 macOS Node 会返回 `ENOTSUP`。响应 multicast TTL
显式设为 255；TTL0 记录只表示 DNS goodbye，不等同 IP TTL。

### etcd provider

`@likego/registry-etcd` 通过应用注入的标准 Fetch 调用 etcd v3 JSON gateway，不依赖 gRPC、Protobuf 或
Node SDK。

- 每个 cooperating publisher 使用独立 token key 与 lease；多 Node generation 通过一个 transaction 完成
  compare、旧 key 删除与新 key 写入，避免半组更新。
- transaction 响应丢失必须通过新旧 key 的 exact readback 证明结果，不能按异常类型猜测成功。
- heartbeat 发现 lease 失效后，为仍属 current 的 generation 申请新 lease 并恢复同一不可变 payload。
- watcher 使用 watch-first、range、revision + 1，compaction 后 fresh range 并继续；availability outage 保留
  last-good。

### Kubernetes EndpointSlice provider

`@likego/registry-kubernetes` 只通过注入的标准 Fetch 使用 namespaced
`discovery.k8s.io/v1 EndpointSlice`。它不创建 core Service、CRD 或全局 controller，也不依赖 Kubernetes
SDK。

- canonical hash 用于 resource name 与 label，原始 Unicode service/node 内容保存在受管 annotation 中并
  做完整 hash 验证。
- cooperating publisher 的 token 集写入同一 Slice；update 与 delete 都携带 `resourceVersion` CAS。
- watcher 对 `410 Gone` 执行 fresh list/re-watch；foreign Slice 与其他 namespace 必须保持不变。
- Kubernetes 没有与 registration owner 等价的 EndpointSlice server-side TTL；进程强杀后的回收依赖
  workload lifecycle 或独立 controller，provider 不伪造 lease 能力。

### ZooKeeper provider

`@likego/registry-zookeeper` 使用 `node-zookeeper-client` 管理 Node.js/Bun 原生会话，因此不声明 Deno 或
portable Web API 支持。

- 每次 registration 使用独立 ephemeral token child；最后一个 token 消失后逻辑实例才消失。
- native `multi` 一旦提交便不能由调用方取消。提交后的 Context 取消只结束 caller wait；provider 仍等待真实
  callback，以 exact readback 判断是否提交，再删除新 token 并恢复被替换的旧 generation。
- 若取消回滚的 readback 或反向 mutation 结果不确定，provider 会关闭整个歧义 session，使可能残留的
  ephemeral token 失效，再用新 session 恢复仍由已接纳 handle 持有的 generation，不能留下 ghost registration。
- ZooKeeper one-shot watch 每次触发后重新安装，并用周期 reconcile 补偿断线窗口。
- session expiration 丢弃旧 client，建立新 session，并恢复仍属 current owner 的 ephemeral nodes。
- digest auth、creator ACL 和 credential redaction 保持 provider 原生语义；凭据不进入错误或公共快照。
- registration 或 watcher 被动失败时，稳定 `done()` 必须先加入串行 mutation tail、recovery timer、state
  listener 与 session close；cleanup 失败按主错误优先聚合，hard drain 只能形成明确的次级失败，不能提前发布
  虚假的资源终态。

### Discovery 与端点选择

`discovery(registry, resolver)` 固定采用 watch-first、initial get、raw event reconcile 与周期 resync。它承诺
eventual convergence，不声称跨 provider linearizability。raw watcher overflow 是 terminal；便利层可以按
有界重试重建 watcher，超过 `resyncRetries` 才进入 terminal。

初始 get 或 resolver 尚未完成时，raw watcher terminal 必须能够取消 admission 并完成 cleanup；永久 pending
的 provider 调用不能阻塞 terminal publication。

Selector 只消费 resolver 输出的 `ServiceInstance` snapshot，不持有 resident 资源、不发起 Transport 操作，
也不执行 retry。当前提供：

- `newRoundRobinSelector`：按稳定 endpoint identity 轮询；成员变化不会重置仍存活 endpoint 的游标。
- `newRandomSelector`：随机源可注入，便于确定性测试。
- `newWeightedRoundRobinSelector`：按声明权重选择，不把运行时延迟偷换成静态权重。
- `newP2CSelector`：从两个候选中比较在途负载，并通过显式 `SelectionDone` feedback 更新观测。

游标和反馈域由 service identity 隔离。应用仍负责决定哪些调用结果代表 endpoint failure；ServiceError、caller
取消与 transport failure 不能被 selector 擅自混为一类。

### 服务调用组合

`@likego/client` 只提供一种 unary Client。配置 Discovery 后，它按服务名懒建立唯一 watcher；同一服务的并发
首次调用共享一次接纳。首次接纳以 watcher 的第一个 replacement snapshot 作为 barrier，再执行 fresh get 发布
当前完整 snapshot，避免 watch/get 竞态；之后每个 replacement snapshot（包括空 snapshot）都原子替换缓存，
因此服务清空时 fail closed。watcher 终止时保留最后完整 snapshot，并在固定一秒退避后重建。
`client.close(ctx)` 取消并停止所有已接纳 watcher，之后的调用稳定失败。直连 Client 不创建 watcher，也不要求
Discovery 或 Selector。

默认调用在首次完整快照为空时立即 fail closed。构造时显式加入 `withBlock()` 后，调用只在该服务历史上第一次
出现原始 endpoint 之前等待；每个调用 Context 仅限制自己的等待，不停止或取消共享 watcher。ready 状态单调，
首次就绪后的空 replacement snapshot 仍立即 fail closed，filter 结果也不会伪装 discovery readiness。

每次 attempt 都从当前 snapshot 选择端点；selection 成功后恰好执行一次 feedback。LikeGo 不新增
`ResidentClient` 或公开 pool。高层 Client 按 address 保留至多一个空闲 Transport Client，成功调用可跨次
复用，活跃 lease 不共享；失败 attempt 与多余并发 owner 立即关闭。portable Fetch 的物理连接复用继续归
runtime；Node HTTP provider 在同一个 Transport Client 内拥有并复用 H1 keep-alive connection 或 H2 session，
处理 GOAWAY drain 与 `withConnClose()` 旁路。`client.close(ctx)` 关闭空闲、活跃和迟到连接。idle owner 在整个
Client 范围默认最多 100 个、60,000ms 过期；`poolSize(...)` 和 `poolTtl(...)` 只控制空闲
owner，不伪装成 Transport 并发或多路复用能力。

feedback 的 `SelectionOutcome` 对齐 Kratos `DoneInfo`。Client 始终报告 `bytesSent` 与 `bytesReceived`，
并仅在 response 通过 Message snapshot 后附带独立、不可变的规范化 `replyMetadata`；内置 selector 仍只使用
`error` 做健康分类，扩展字段不改变既有算法。

业务调用默认只尝试一次，也不创建私有业务 timeout。只有每次 `call` 显式传入带重放授权的
`withRetry(...)`，才会通过 `@likego/resilience` 执行有界 attempt；每次 attempt 从 watcher 的最新快照重新选择，
但复用调用开始时已快照的同一 Message。注入的 Transport provider 仍可拥有 provider-specific 默认策略，例如 HTTP Transport
的响应头 admission timeout。

一次 `call` 只有业务交换、selection feedback 与 owned Transport Client close 全部完成才直接返回 response。
业务交换已完成而后置 feedback/close 失败时，抛出原生 `AggregateError`；防御快照后的 response 位于 `cause`，
`errors` 按“feedback、close”排序；该终态不得进入 retry。主调用失败时，单一 primary 保持原始 Error identity，另有
后置失败才按“主调用、feedback、close”组成 `AggregateError`。这样普通 Client 无需私有后台任务或全局 logger，
也不会把 close timeout、反馈失败、资源 orphan 或已经发生的业务事实静默丢掉。

该组合只面向内部 `Message` Transport，不依赖 `@likego/web`。外部入站 HTTP、router、middleware 和
Request/Response 策略继续由 Web 层与应用拥有。

### 韧性组合

`@likego/resilience` 提供显式 retry/backoff、circuit breaker 与 token-bucket limiter。应用可以先从 Registry
取得 snapshot，再选择 endpoint，并在明确幂等的 operation 内创建新请求。Registry、selector 与 Transport
不会自动重放请求或推断幂等性。

## 真实服务 E2E

Consul 固定使用 2.0.2 真实容器，覆盖 register/get/catalog/passing watch、TTL crash、ACL、Agent restart、
outage recovery、generation restore、lost-response readback、redirect fail-closed 与零残留。

etcd 固定使用 3.7.1 容器，覆盖 transaction、lease、watch、compaction、restart、publisher crash expiry、
lost-response exact readback 与零残留。

Kubernetes 使用固定 digest 的单节点 K3s，覆盖最小 namespaced RBAC、EndpointSlice create/update/delete、
resourceVersion conflict、410 relist、foreign isolation、token 合并和 namespace/container/volume 清理。

ZooKeeper 使用固定 3.9.5 容器，覆盖 ephemeral child、提交后取消的 exact readback 与 rollback、one-shot watch
re-arm、session expiration/reconnect、digest ACL、publisher crash cleanup 和
znode/session/container/network/volume 清理。

mDNS 使用两个独立 Node 容器和自定义 bridge，覆盖 IPv4/IPv6 multicast、register/get/list、完整 metadata/
Endpoint/Value、watch create/update/delete、逆序 generation restore、collision、TTL0 goodbye、publisher
`SIGKILL` 后 expiry、packet capture、socket inode、容器与网络清理。平台不支持某个 family 时必须形成明确
unsupported 结果，不能冒充通过。

## 推迟与排除

Nacos、Eureka、Polaris、ServiceComb 等 provider，以及 consistent-hash、locality/subset 和
outlier-ejection selector 留给后续真实需求。Registry 不引入 gRPC/Protobuf、带路由、codec、middleware 或
隐式重试的全功能 RPC client 门面、统一 broker、全局 metadata、全局 codec registry、store/ORM abstraction
或隐式 middleware。

## 后果

LikeGo 获得与被调研 Go 工具包同角色的 Registry 能力，同时保持 provider、Transport 和 Web 的边界清晰。
应用可以替换 provider、resolver 或 Server host，而不改变公共生命周期；每个 resident 资源只有一个 owner，
所有发现与选择失败都在调用点显式可见。
