# go-like Examples

## 建议阅读路径

1. `vanilla-web`：用标准 Fetch Handler 跑通最小 Web Server 与 App 生命周期。
2. `hono`：把现有 Hono 应用接入同一 Web 生命周期，不学习第二套路由 API。
3. `bank-transfer-gateway`：跑通类型化 endpoint/JSON codec → Client → Memory Transport → unary Server。
4. `commerce-catalog`：加入 Registry、Redis Cache 与真实 Docker 依赖。
5. `enterprise-platform-runtime`：查看 Config、Registry、可观测性与服务调用的完整装配。

## 目录范围

本目录是 go-like 可执行案例入口，覆盖行业微服务、Worker、scheduler、message consumer 以及第三方 Web
框架接入。案例只随真实业务不变量或接入需求增加，目录中的可运行程序就是维护对象。

## 直接运行

每个案例都是在本仓库 workspace 内可独立启动、测试的 private 小程序，而不是只供阅读或测试导入的代码片段。
案例依赖仓库内的 `workspace:*` 包；复制单个目录不等于得到可独立安装或发布的项目。

- `src/main.ts` 是唯一进程与 App 装配入口，负责真实监听或消息消费、go-like 生命周期和信号停止；
- 其他源码只暴露 Handler、结构化 Server 或资源，不创建内层 App，也不另起一套手工生命周期；
- 业务、HTTP、Client/Server 或外部资源只有在确实需要独立讲解、测试或生命周期时才拆文件；
- 不统一套用 `domain/application/infrastructure/entrypoint`，也不保留二次转发的 barrel；
- `bun run start` 先构建仓库内 go-like 包；Node.js 案例构建 `--target=node` 后运行产物，明确使用 Bun 的案例
  直接运行源码入口；
- 程序完成启动后输出 `GO_LIKE_EXAMPLE_READY=...`，按 `Ctrl-C` 可优雅停止。

不依赖外部服务的案例可从仓库根目录直接运行，例如：

```sh
bun run --filter @go-like/example-retail-inventory-reservation start
```

默认 HTTP 地址是 `http://127.0.0.1:3000`，可通过 `HOST`、`PORT` 覆盖。部分 `production`
案例（例如 `commerce-catalog`、`saas-tenant-api`、`payments-ledger`、`iot-telemetry`、
`batch-reporting`、`enterprise-platform-runtime`）的默认启动依赖真实 Consul、Redis、PostgreSQL、
NATS、Vault 或 OpenTelemetry Collector；先按各案例 README 启动其固定版本 Docker 依赖，再执行
相同的 `start` 命令。`iot-telemetry` 和 `batch-reporting` 分别把消息消费与定时任务适配为 Core
Server，不伪装成 HTTP 服务。`cybersecurity-alert-triage` 默认使用固定
Config、不注册 Registry，并以内存台账保存结果，可直接运行；其可选 etcd Config、Registry 与 Store
接入由固定 digest Docker E2E 验证。

单元测试与可执行程序 E2E 分开运行；后者会真实启动、探测并停止程序，需要中间件的案例会使用 Docker：

```sh
bun run test:unit
bun run test:e2e:examples
```

Examples E2E 的输入由 runner 每次从 immediate `examples/*/package.json` 动态生成，而不是维护另一份静态目录清单。每个 example 必须在同一变更中提供非空 `test:e2e` wrapper、明确的 tsconfig owner 和必要文档；wrapper 的注册、ACK、结果与 cleanup 任一失败都会使 aggregate 非零。直接运行 workspace E2E 前先从仓库根目录执行一次 `bun run build`，并准备该案例声明的 runtime 与 Docker prerequisite。

## 验证层级

- `core`：用最小可运行代码证明一个独立业务不变量和标准 Web API 边界。
- `integration`：证明多个职责或服务边界的协作、幂等、取消或故障收敛。
- `production`：除单元验证外，还通过固定版本真实中间件 Docker E2E 验证。

Tier 不自动代表 Docker。只有表格明确列出真实服务的案例才需要 Docker E2E；focused
案例使用进程内基础设施验证业务边界，不把未来可能接入的数据库、Broker 或外部 API
描述成已经实现。

## 业务案例

|   # | 案例                                                                         | 行业与业务不变量                           | 当前 go-like 微服务能力 / 调用链                                                     | Tier        | Docker 判定                                           |
| --: | ---------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------ | ----------- | ----------------------------------------------------- |
|   1 | [`commerce-catalog`](./commerce-catalog/README.md)                           | 电商：缓存失效时仍从 Pricing 获取权威价格  | Hono/Web → Cache → Client + Retry → HTTP Pricing；Docker 注入 Redis/Consul           | production  | 是：Consul 2.0.2、Redis 8.10.0                        |
|   2 | [`saas-tenant-api`](./saas-tenant-api/README.md)                             | SaaS：配置、缓存和限流不得跨租户泄漏       | Hono/Web → Config + Cache → Token Bucket；Consul Store 保存 runtime state            | production  | 是：Consul 2.0.2、Redis 8.10.0                        |
|   3 | [`payments-ledger`](./payments-ledger/README.md)                             | 支付：分录借贷平衡且幂等键只能生效一次     | Web + Core-owned outbox publisher Server → PostgreSQL ledger/outbox → NATS JetStream | production  | 是：PostgreSQL 18.4、NATS 2.14.4                      |
|   4 | [`iot-telemetry`](./iot-telemetry/README.md)                                 | IoT：稳定事件标识供下游幂等收敛重复        | NATS JetStream → Broker consumer → validation/dedup → Ack 或 DLQ                     | production  | 是：NATS JetStream 2.14.4                             |
|   5 | [`batch-reporting`](./batch-reporting/README.md)                             | 报表：重跑保持窗口标识且输出必须幂等       | Croner/BullMQ E2E composition → report use case → Store checkpoint                   | production  | 是：Redis 8.10.0；BullMQ/Croner 在应用进程            |
|   6 | [`enterprise-platform-runtime`](./enterprise-platform-runtime/README.md)     | 企业平台：App 统一停止配置、服务与遥测组件 | Vault Config/Store + Consul Registry → unary HTTP → OTel/Pino/Prometheus             | production  | 是：Consul 2.0.2、Vault 2.0.3、OTel Collector 0.157.0 |
|   7 | [`retail-inventory-reservation`](./retail-inventory-reservation/README.md)   | 零售：并发预占不超卖且重试不重复扣减       | Web → inventory use case → immediately usable Memory Cache                           | integration | 否：进程内 Cache 与单元测试                           |
|   8 | [`marketplace-order-fulfillment`](./marketplace-order-fulfillment/README.md) | 平台电商：履约事件合法迁移且重投幂等       | Web → fulfillment state machine → Core-owned Worker                                  | integration | 否：结构化 Worker 与内存仓储                          |
|   9 | [`subscription-billing`](./subscription-billing/README.md)                   | 订阅：升降级差额按剩余账期确定性结算       | Object Config → proration policy → Web                                               | integration | 否：Object Source 与内存账单仓储                      |
|  10 | [`bank-transfer-gateway`](./bank-transfer-gateway/README.md)                 | 银行：转账只能路由到适用清算网络           | Web → typed endpoint/JSON codec → Client → Memory Transport → unary Server           | integration | 否：仅真实 Memory Transport，不连接银行网络           |
|  11 | [`insurance-claims`](./insurance-claims/README.md)                           | 保险：赔付受承保期、免赔额和累计上限约束   | Web → claim policy/repository → Core-owned review Worker                             | integration | 否：结构化 Worker 与内存仓储                          |
|  12 | [`fraud-risk-scoring`](./fraud-risk-scoring/README.md)                       | 风控：受控信号评分且依赖失败时熔断         | Web → Memory Cache → Circuit Breaker → scoring dependency                            | integration | 否：进程内 Cache/Breaker                              |
|  13 | [`securities-market-data`](./securities-market-data/README.md)               | 证券：行情序列不倒退且拒绝冲突重放         | Web ingest → ordered quote repository → Health readiness                             | integration | 否：进程内快照与 Probe                                |
|  14 | [`healthcare-appointments`](./healthcare-appointments/README.md)             | 医疗：同一医生有效预约时段不得重叠         | Web → Client → Memory Transport → unary policy Server → booking                      | core        | 否：仅真实 Memory Transport，不连接外部医疗系统       |
|  15 | [`laboratory-results`](./laboratory-results/README.md)                       | 检验：结果只能进入匹配就诊上下文           | Web → Metadata allowlist propagation → audit sink；Health probes readiness           | integration | 否：进程内 Metadata/Probe                             |
|  16 | [`pharmacy-prescription`](./pharmacy-prescription/README.md)                 | 医药：库存失败不能标记处方已发药           | Web → bounded Resilience retry → idempotent inventory gateway                        | integration | 否：内存 Inventory gateway                            |
|  17 | [`logistics-shipment-tracking`](./logistics-shipment-tracking/README.md)     | 物流：乱序和重复事件不得使状态倒退         | Web → ordered transition → process-local Memory Cache projection                     | integration | 否：进程内 Memory Cache                               |
|  18 | [`warehouse-wave-picking`](./warehouse-wave-picking/README.md)               | 仓储：拣货任务只能由一个有效租约执行       | Web + lease repository → structural pick-worker Core Server                          | integration | 否：结构化 Worker 与内存租约                          |
|  19 | [`last-mile-dispatch`](./last-mile-dispatch/README.md)                       | 配送：订单只能派给满足容量约束的节点       | Web → capacity-aware dispatch → Health readiness probe                               | integration | 否：进程内目录与 Probe                                |
|  20 | [`airline-irregular-operations`](./airline-irregular-operations/README.md)   | 航空：旅客只保留一个有效航变处置结果       | Web → Registry selector；可选 ZooKeeper App 注册                                     | integration | 否：默认静态集合；真实 ZooKeeper 由环境注入           |
|  21 | [`hotel-room-reservation`](./hotel-room-reservation/README.md)               | 酒店：跨夜预留不超卖且显式释放恢复库存     | Web → nightly room repository → Health readiness                                     | core        | 否：进程内仓储与 Probe                                |
|  22 | [`public-transit-arrivals`](./public-transit-arrivals/README.md)             | 公交：过期到站预测不得作为当前结果         | Web → freshness filter → Health feed-freshness probe                                 | core        | 否：进程内预测仓储与 Probe                            |
|  23 | [`manufacturing-maintenance`](./manufacturing-maintenance/README.md)         | 制造：同一故障窗口只创建一个维保工单       | Web → fault-window dedup → Health repository-readiness probe                         | integration | 否：进程内工单仓储与 Probe                            |
|  24 | [`energy-meter-settlement`](./energy-meter-settlement/README.md)             | 能源：使用配置快照与安全整数金额结算       | Object Config tariff snapshot → integer settlement → Web                             | integration | 否：Object Config 与内存结算仓储                      |
|  25 | [`ev-charging-control`](./ev-charging-control/README.md)                     | 充电：分配不超容量且离线站点不接单         | Web → station capacity/idempotency → Health readiness                                | integration | 否：进程内站点目录与 Probe                            |
|  26 | [`smart-agriculture-irrigation`](./smart-agriculture-irrigation/README.md)   | 农业：数据过期时不得继续灌溉               | Config policy snapshot → stale-reading guard → Web                                   | core        | 否：Object Config 与进程内读数                        |
|  27 | [`telecom-service-provisioning`](./telecom-service-provisioning/README.md)   | 电信：重试不得重复分配 SIM 或资源          | Web → Client → Memory Transport → unary Server → provisioning                        | integration | 否：仅真实 Memory Transport，不连接 OSS/BSS           |
|  28 | [`media-transcoding-pipeline`](./media-transcoding-pipeline/README.md)       | 媒体：相同转码任务只产生确定性结果         | Web → idempotent worker → Core-owned Server                                          | integration | 否：结构化 Worker 与内存结果仓储                      |
|  29 | [`live-game-matchmaking`](./live-game-matchmaking/README.md)                 | 游戏：同区近似水平匹配且玩家不重复入队     | Web → Registry selector；可选 Kubernetes EndpointSlice App 注册                      | core        | 否：默认静态集合；真实 Kubernetes API 由环境注入      |
|  30 | [`ad-campaign-serving`](./ad-campaign-serving/README.md)                     | 广告：投放不得突破预算和频控               | Web → Token Bucket → Core-owned Memory Cache → Circuit Breaker creative source       | integration | 否：进程内 Cache/Limiter/Breaker                      |
|  31 | [`learning-enrollment`](./learning-enrollment/README.md)                     | 教育：并发不超容量且重试不重复占位         | Web → Memory Transport capacity service → Core-owned Server → enrollment             | core        | 否：仅真实 Memory Transport，不连接数据库             |
|  32 | [`government-permit-workflow`](./government-permit-workflow/README.md)       | 政务：按材料政策审核且重复提交幂等         | Web → permit repository → Core-owned review Worker                                   | integration | 否：结构化 Worker 与内存仓储                          |
|  33 | [`real-estate-search-index`](./real-estate-search-index/README.md)           | 房地产：撤回房源不得继续显示可售           | Web → revision-aware index → Core-owned Memory Cache                                 | core        | 否：进程内 Memory Cache                               |
|  34 | [`restaurant-kitchen-routing`](./restaurant-kitchen-routing/README.md)       | 餐饮：任务只进入可用档口且不重复出餐       | Web → Health + Registry selector；可选真实 mDNS App 注册                             | core        | 否：默认静态集合；mDNS 模式使用真实 UDP multicast     |
|  35 | [`cold-chain-monitoring`](./cold-chain-monitoring/README.md)                 | 冷链：配置快照判温且读数序列只增不减       | Object Config limits → sequence ledger → Web                                         | integration | 否：Object Config 与内存台账                          |
|  36 | [`customer-support-routing`](./customer-support-routing/README.md)           | 客服：语言技能筛选并在候选坐席间轮转       | Web → language/skill filter → Registry selector → agent                              | core        | 否：静态 ServiceInstance 集合                         |
|  37 | [`notification-delivery`](./notification-delivery/README.md)                 | 通知：有界重试且请求重放不重复投递         | Web/Winston → Retry → typed Event → Memory Broker/Store projection                   | integration | 否：明确的进程内 Broker、Store 与 Provider            |
|  38 | [`cybersecurity-alert-triage`](./cybersecurity-alert-triage/README.md)       | 安全：规则取最高严重度且重复上报幂等       | Config + Health → ledger；可选 etcd Config/Registry/Store                            | production  | 是：固定 digest etcd 3.7.1 Docker E2E                 |
|  39 | [`digital-identity-verification`](./digital-identity-verification/README.md) | 身份：请求只进入受信校验路径且不泄漏证件   | Web → Health provider readiness → timeout/Circuit Breaker → provider                 | integration | 否：内存 Identity Provider                            |
|  40 | [`emergency-response-dispatch`](./emergency-response-dispatch/README.md)     | 公共安全：紧急事件优先分派且超时取消       | Web → zone/service/readiness filter → Registry selector → responder                  | integration | 否：静态 ServiceInstance 集合                         |

## 第三方框架接入案例

以下四项专门演示第三方 Web 框架或原生 Fetch Handler 如何接入 go-like，同样属于正式 examples。

| 案例                                     | 验证入口                                    | Tier        | Docker 判定       |
| ---------------------------------------- | ------------------------------------------- | ----------- | ----------------- |
| [`elysia`](./elysia/README.md)           | Elysia `app.fetch` → `@go-like/web` Handler | integration | 否：Node 接入测试 |
| [`h3`](./h3/README.md)                   | H3 `app.fetch` → `@go-like/web` Handler     | integration | 否：Node 接入测试 |
| [`hono`](./hono/README.md)               | Hono `app.fetch` → `@go-like/web` Handler   | integration | 否：Node 接入测试 |
| [`vanilla-web`](./vanilla-web/README.md) | 原生 Fetch Handler → go-like Web 生命周期   | integration | 否：Node 接入测试 |

案例取舍、互斥边界和职责拆分规则见
[`docs/example-portfolio.md`](../docs/example-portfolio.md)。
