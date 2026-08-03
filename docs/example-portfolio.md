# LikeGo Examples 组合

本组合覆盖多种行业微服务，以及 `elysia`、`h3`、`hono` 和 `vanilla-web` 等框架接入。后续只有在出现
新的真实行业不变量或接入需求时才增加案例；目录本身就是可运行示例集合。

## 验证层级

- `core`：验证单一业务不变量和便携核心能力。
- `integration`：验证多个 LikeGo 能力之间的协作与故障边界。
- `production`：验证真实中间件、传输安全、恢复或进程生命周期。

层级表示验证深度，不表示案例的重要程度。

## 业务案例

|   # | 案例                            | 行业         | 主要业务不变量                             | 主要能力                                                                    | 层级        |
| --: | ------------------------------- | ------------ | ------------------------------------------ | --------------------------------------------------------------------------- | ----------- |
|   1 | `commerce-catalog`              | 电商         | 缓存失效时仍须从 Pricing 获取权威价格      | Web、Cache、Client、Resilience、Health；Redis/Consul/HTTP providers         | production  |
|   2 | `saas-tenant-api`               | 多租户 SaaS  | 配置、缓存和限流状态不得跨租户泄漏         | Web/Hono、Cache、Resilience；Consul/Redis/Pino providers                    | production  |
|   3 | `payments-ledger`               | 支付         | 分录借贷平衡且幂等键只能生效一次           | Web、Core、标准 JSON 与显式业务校验                                         | production  |
|   4 | `iot-telemetry`                 | 物联网       | 稳定事件标识供下游幂等收敛重复             | Broker、NATS、标准 JSON 与显式业务校验                                      | production  |
|   5 | `batch-reporting`               | 数据报表     | 重跑保持窗口标识且输出必须幂等             | Croner、BullMQ、File Store                                                  | production  |
|   6 | `enterprise-platform-runtime`   | 企业基础平台 | App 统一停止配置、服务与遥测组件           | Vault Config、Consul Registry、HTTP Transport、Health、OTel/Pino/Prometheus | production  |
|   7 | `retail-inventory-reservation`  | 全渠道零售   | 并发预占不得超卖且请求重试不得重复扣减     | Web、Cache、Memory Cache、Core                                              | integration |
|   8 | `marketplace-order-fulfillment` | 平台电商     | 履约事件只能合法迁移且重投结果必须幂等     | Web、Core                                                                   | integration |
|   9 | `subscription-billing`          | 订阅计费     | 升降级差额必须按剩余账期确定性结算         | Web、Config                                                                 | integration |
|  10 | `bank-transfer-gateway`         | 银行         | 转账必须按国家币种与 BIC 路由清算网络      | Web、Client、Server、Memory Transport                                       | integration |
|  11 | `insurance-claims`              | 保险         | 赔付必须受承保期免赔额和累计上限约束       | Web、Core                                                                   | integration |
|  12 | `fraud-risk-scoring`            | 金融风控     | 风险评分必须使用受控信号并在依赖失败时熔断 | Web、Cache、Memory Cache、Resilience                                        | integration |
|  13 | `securities-market-data`        | 证券         | 行情序列不得倒退且冲突重放必须拒绝         | Web、Health                                                                 | integration |
|  14 | `healthcare-appointments`       | 医疗服务     | 同一医生时段只能被一个有效预约占用         | Web、Client、Server、Transport、Memory Transport                            | core        |
|  15 | `laboratory-results`            | 临床检验     | 结果只进入匹配就诊上下文且日志不暴露正文   | Web、Metadata、Health                                                       | integration |
|  16 | `pharmacy-prescription`         | 医药         | 处方合法流转且库存失败不能标记已发药       | Web、Resilience                                                             | integration |
|  17 | `logistics-shipment-tracking`   | 物流         | 乱序和重复事件不得使包裹状态倒退           | Web、Memory Cache                                                           | integration |
|  18 | `warehouse-wave-picking`        | 仓储         | 拣货任务只能由一个有效租约执行并可恢复     | Web、Core                                                                   | integration |
|  19 | `last-mile-dispatch`            | 末端配送     | 订单只能派给满足容量约束的健康节点         | Web、Health                                                                 | integration |
|  20 | `airline-irregular-operations`  | 航空         | 航变任务可重试且旅客只有一个有效处置结果   | Web、Registry                                                               | integration |
|  21 | `hotel-room-reservation`        | 酒店         | 跨夜预留不得超卖且显式释放必须恢复库存     | Web、Health                                                                 | core        |
|  22 | `public-transit-arrivals`       | 公共交通     | 过期到站预测不得作为当前结果返回           | Web、Health                                                                 | core        |
|  23 | `manufacturing-maintenance`     | 制造业       | 同一设备故障窗口只创建一个维保工单         | Web、Health                                                                 | integration |
|  24 | `energy-meter-settlement`       | 能源         | 结算必须使用配置快照与安全整数金额         | Web、Config                                                                 | integration |
|  25 | `ev-charging-control`           | 新能源汽车   | 充电分配不得超容量且离线站点不得接单       | Web、Health                                                                 | integration |
|  26 | `smart-agriculture-irrigation`  | 智慧农业     | 数据过期或配置失效时不得继续灌溉           | Web、Config                                                                 | core        |
|  27 | `telecom-service-provisioning`  | 电信         | 重复开通不得重复分配 SIM 或资源            | Web、Client、Server、Memory Transport                                       | integration |
|  28 | `media-transcoding-pipeline`    | 数字媒体     | 相同转码任务只能产生一个确定性结果         | Web、Core                                                                   | integration |
|  29 | `live-game-matchmaking`         | 在线游戏     | 玩家不得重复入队且只能匹配同区近似水平玩家 | Web、Registry                                                               | core        |
|  30 | `ad-campaign-serving`           | 广告技术     | 投放不得突破预算和频控上限                 | Web、Memory Cache、Core、Resilience                                         | integration |
|  31 | `learning-enrollment`           | 在线教育     | 并发选课不得超容量且请求重试不得重复占位   | Web、Core、Transport、Memory Transport                                      | core        |
|  32 | `government-permit-workflow`    | 政务         | 许可申请必须按材料政策审核且重复提交幂等   | Web、Core                                                                   | integration |
|  33 | `real-estate-search-index`      | 房地产       | 房源撤回后陈旧索引不得返回可售状态         | Web、Memory Cache、Core                                                     | core        |
|  34 | `restaurant-kitchen-routing`    | 餐饮         | 任务只进入可用档口且重复事件不重复出餐     | Web、Registry、Health                                                       | core        |
|  35 | `cold-chain-monitoring`         | 食品冷链     | 温度判定必须使用配置快照且读数序列只增不减 | Web、Config                                                                 | integration |
|  36 | `customer-support-routing`      | 客户服务     | 工单必须按语言技能筛选并在候选坐席间轮转   | Web、Registry                                                               | core        |
|  37 | `notification-delivery`         | 消息通信     | 通知重试必须有界且重复请求不得重复投递     | Web、Resilience                                                             | integration |
|  38 | `cybersecurity-alert-triage`    | 网络安全     | 告警必须按规则取最高严重度且重复上报幂等   | Web、Config、Health                                                         | production  |
|  39 | `digital-identity-verification` | 数字身份     | 请求只发送到受信服务且日志不记录证件内容   | Web、Resilience、Health                                                     | integration |
|  40 | `emergency-response-dispatch`   | 公共安全     | 紧急事件优先投递到健康节点且超时立即取消   | Web、Registry                                                               | integration |

## 目录契约

每个案例都是在本仓库 workspace 内可以直接启动和停止的 private 小程序，必须包含：

- 非空 `README.md`；
- `src/main.ts` 作为唯一进程与 App 装配入口；
- 至少一个可由测试直接复用的业务或接入模块；
- 至少一个非空 `test/**/*.test.ts`。

文件只按案例真实职责拆分，例如 `service.ts`、`http.ts`、`worker.ts`、`transport.ts`、`config.ts`
或框架案例的 `routes.ts`、`app.ts`。不统一套用
`domain/application/infrastructure/entrypoint`，也不保留只做二次转发的 `program.ts` 或 barrel。
测试直接导入职责模块，不通过 `main.ts` 启动隐式进程。
职责模块只暴露 Handler、结构化 Server 或资源，不创建内层 App，也不为测试复制手工启动路径。

所有案例均为 private workspace，不声明版本、不发布构建产物，也不得提交 `dist/` 或 `.artifacts/`。它们使用
`workspace:*` 依赖，复制单个目录不等于得到可独立安装或发布的项目。

## 合并与排除边界

- 商品与商品搜索归入 `commerce-catalog`；库存预占归入
  `retail-inventory-reservation`；履约编排归入
  `marketplace-order-fulfillment`。
- 钱包和会计分录归入 `payments-ledger`；周期账单归入
  `subscription-billing`；银行网络调用归入 `bank-transfer-gateway`。
- 通用设备上报归入 `iot-telemetry`；能源结算、灌溉控制和冷链告警因业务不变量不同而独立。
- Email、SMS 和 Push 不分别建案例，统一归入 `notification-delivery`。
- Blog、Todo、Hello World、普通 CRUD，以及没有具体接入或业务不变量的单一 Config、Registry、TLS、Health、
  Tracing 或 Broker producer/consumer 片段不单独建案例；第三方框架接入本身具有明确边界，因此是正式 example。

## 第三方框架接入案例

- [`elysia`](../examples/elysia/README.md)：Elysia 通过 `@likego/elysia` 接入 `@likego/web` Handler。
- [`h3`](../examples/h3/README.md)：H3 通过 `@likego/h3` 接入 `@likego/web` Handler。
- [`hono`](../examples/hono/README.md)：Hono 通过 `@likego/hono` 接入 `@likego/web` Handler。
- [`vanilla-web`](../examples/vanilla-web/README.md)：原生 Fetch Handler 由 LikeGo Web 生命周期承接。
