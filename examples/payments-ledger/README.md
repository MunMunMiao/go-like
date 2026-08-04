# PostgreSQL 双录支付账本

> `src/main.ts` 是唯一程序入口；单元测试和固定 digest 的 PostgreSQL + NATS Docker E2E 均可运行。

## 代码结构

- `src/payment.ts`：支付请求、账本事件、金额、标识与 Context 校验。
- `src/post-payment.ts`：幂等入账、双录分录与 Outbox 原子事务。
- `src/postgres.ts`：迁移、延迟约束、不可变触发器与账户写入。
- `src/nats.ts`：短租约领取、JetStream `PubAck` 与失败释放。
- `src/worker.ts`：把 outbox publisher 承接为结构式 go-like Server。
- `src/http.ts`：标准 Web API 支付入口。
- `src/main.ts`：连接 PostgreSQL 与 NATS、组装所有 Server，并直接启动完整小程序。

本示例展示一个最小但可审计的支付入账服务：PostgreSQL 是唯一金融事实源；一笔支付在同一个数据库事务内写入
双录分录、幂等结果和 outbox 事件；事务提交后，独立 publisher 再把 outbox 事件可靠发布到 NATS
JetStream。go-like 管理请求 Context 与标准 Handler 边界；SQL、NATS 和进程生命周期由应用拥有。go-like 不充当
账本、ORM 或跨系统事务协调器。

`src/main.ts` 创建标准 Web `Handler`，同时把
`publishNextOutbox(...)` 轮询包装为结构式 Server，并通过
`newApp(name("payments-ledger"), server(dependencies, publisher, web))` 一次性把全部 Server
交给 `@go-like/core`。App
成功接纳后由 Core 调用 Server 的 `start(ctx)`，并在停止时调用 `stop(ctx)`；停止会取消当前 publisher
Context、清除 poll timer，并等待已接纳 attempt 收敛。Core 会并发请求停止 Web、publisher 与依赖资源；
需要依赖顺序时，由相应 Server 在自己的 `stop(ctx)` 内负责。

## 直接运行

先启动示例所需的真实 PostgreSQL 与 NATS，再直接启动小程序：

```bash
docker compose -f examples/payments-ledger/compose.yaml up -d --wait
bun run --filter @go-like/example-payments-ledger start
```

默认监听 `http://127.0.0.1:3000`，并连接 Compose 暴露的 `127.0.0.1:35432` 与
`127.0.0.1:34222`。可通过 `HOST`、`PORT`、`DATABASE_URL`、`NATS_URL` 和
`PUBLISHER_OWNER` 覆盖。结束后执行：

```bash
docker compose -f examples/payments-ledger/compose.yaml down -v
```

## 用户角色

| 角色           | 目标与职责                                                                              |
| -------------- | --------------------------------------------------------------------------------------- |
| 支付调用方     | 携带稳定的 `Idempotency-Key` 提交一次入账请求；网络超时后可以安全重试同一请求。         |
| 账本服务       | 校验请求，在 PostgreSQL 中原子写入平衡分录、幂等结果和 outbox；只有提交成功才返回成功。 |
| 财务与审计人员 | 以不可变 journal/posting 查询资金变化，使用冲正分录纠错，不直接改写历史分录。           |
| 下游事件消费者 | 订阅 JetStream 账本事件；按稳定 `eventId` 幂等处理，并在需要时回查 PostgreSQL。         |
| 平台运维人员   | 管理 PostgreSQL、NATS、凭据、备份、容量、告警、镜像升级和灾难恢复。                     |

租户身份必须来自经过认证的服务端上下文，不接受请求 body 自报的租户。示例不采集或保存卡号、CVV、银行凭据等
支付工具敏感数据。

## 业务目标与接口边界

第一版只提供一个已入账即终态的内部接口：

```text
POST /v1/ledger/payments
Idempotency-Key: <租户内唯一、1..128 字节的可见 ASCII 字符串>

{
  "debitAccountId": "account_customer_1",
  "creditAccountId": "account_merchant_1",
  "currency": "USD",
  "amountMinor": "1250",
  "reference": "order_1001"
}
```

- `amountMinor` 是正整数的十进制字符串，进入 PostgreSQL 后保存为 `bigint`；不得经过 JavaScript
  `number`、浮点数或 PostgreSQL `money`。
- 一笔 journal 只允许一种货币。账户、journal 与 posting 的租户和货币必须一致。
- 首次成功请求返回已提交的 `transactionId`；同一幂等键和相同规范化请求重放已保存的响应；同一键配不同请求
  返回 `409`，且不新增任何账本或 outbox 行。
- 应用用显式 TypeScript 类型和字段检查解析请求，并继续执行非空、长度、正整数、货币、账户不同和租户归属
  等金融约束。

## 架构与请求、数据流

```text
支付调用方
    │ HTTP
    ▼
标准 Request/Response Handler + go-like Web Context
    │ 单个 PostgreSQL transaction
    ├── idempotency_request
    ├── ledger_transaction
    ├── ledger_posting (至少两行且按货币和为 0)
    └── outbox_event
             │ commit 后由 publisher 领取
             ▼
      NATS JetStream PubAck
             │
             ▼
       幂等的下游消费者
```

### PostgreSQL 数据模型

| 表                    | 最小职责                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------ |
| `ledger_account`      | 保存租户、货币和账户状态；posting 只能引用同租户、同货币的有效账户。                                         |
| `idempotency_request` | 以 `(tenant_id, idempotency_key)` 唯一；保存规范化 `request_payload`、HTTP status/body 和 `transaction_id`。 |
| `ledger_transaction`  | 一次业务 journal 的不可变头信息，包括租户、货币、reference 和时间。                                          |
| `ledger_posting`      | 保存 `transaction_id`、`account_id` 和有符号 `amount_minor`；借方为负、贷方为正。                            |
| `outbox_event`        | 保存稳定 `event_id`、subject、schema version、payload、领取租约、尝试次数、下次尝试时间和 `published_at`。   |

数据库迁移必须提供延迟到事务提交时检查的约束触发器，确认每个 transaction 至少有两条 posting，且同一货币的
`amount_minor` 总和为零。外键、`NOT NULL`、`CHECK`、唯一键和账户租户/货币校验也必须由数据库落实；仅在
TypeScript 中计算一次总和不构成金融不变量。账本表拒绝业务 `UPDATE`/`DELETE`，纠错通过引用原交易的新冲正
transaction 完成。可变的发布状态只存在于 outbox，不回写历史分录。

### 入账事务

1. HTTP 层读取可信租户和 `Idempotency-Key`，解析标准 JSON，再执行字段与业务校验。
2. 开启 PostgreSQL transaction，尝试插入 `idempotency_request`。唯一键解决并发竞争，不使用进程内锁。
3. 若键已存在，则在同一 transaction 中读取其规范化 `jsonb` 请求：相同则返回已保存响应，不同则返回
   `409`。
4. 对首次请求创建 `ledger_transaction`，写入一负一正两条 posting，并让数据库约束在提交前复核平衡关系。
5. 在同一 transaction 中写入完整、已校验的 `outbox_event`，再把最终 status/body 写回幂等行。
6. 提交成功后才向调用方返回成功。任一步失败都回滚幂等行、账本和 outbox，不能留下“半笔交易”。

把规范化请求直接存为 `jsonb` 并比较相等即可，不额外设计一套易出错的 canonical JSON hash。幂等行与业务记录
位于同一事务，因此进程崩溃不会留下需要猜测处理的 `in_progress` 状态。

### Outbox 发布

1. Publisher 用一个短 PostgreSQL transaction，通过 `FOR UPDATE SKIP LOCKED` 领取到期且未发布的小批记录，
   写入有期限的 owner lease 后立即提交。
2. 数据库 transaction 结束后，使用官方 `@nats-io/jetstream` client 发布到
   `payments.ledger.v1.posted`，并以 `event_id` 作为 JetStream `msgID`。
3. 只有取得官方 `PubAck` 后，才在新的短 transaction 中写 `published_at`。发布失败时保留记录，使用有上限的
   backoff 更新下次尝试时间；进程死亡后由过期 lease 回收。
4. `PubAck` 成功后、`published_at` 写入前崩溃会导致重复发布。稳定 `eventId` 和 JetStream 去重窗口可以降低
   重复，但不能构成无限期 exactly-once；所有消费者仍必须持久化去重。

PostgreSQL transaction 绝不跨越 NATS 网络调用。JetStream 是通知和分发通道，不是账本事实源；事件顺序也不
替代数据库 journal 顺序。

## go-like 包映射

| 能力               | 采用方式与边界                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------- |
| `@go-like/context` | 作为 HTTP 与 publisher attempt 的独立首参语义；终止的 Context 不启动金融事务。                                |
| `@go-like/web`     | `contextHandler(...)` 承接标准 `Request`/`Response`，租户由接收 Context 的服务端 resolver 注入。              |
| TypeScript + JSON  | 声明请求与 outbox event shape；required presence、字符串类型、金额和账户规则由应用显式检查。                  |
| Bun `SQL`          | 直接提供参数化查询、连接池和 scoped PostgreSQL transaction，不创建 go-like SQL 抽象。                         |
| 官方 NATS SDK      | `@nats-io/transport-node` 拥有连接，`@nats-io/jetstream` 发布并保留真实 `PubAck`。                            |
| `@go-like/store`   | **禁止用于账本、余额、幂等行或 outbox。** Store 没有关系 transaction、数据库约束、索引查询或 migration 契约。 |

go-like 当前没有 SQL/ORM 抽象。实现应直接选择一个支持参数化查询、连接池和 scoped transaction 的 PostgreSQL
driver，并固定其版本；不要为了本示例先造通用 database package。

## 生产不变量

1. PostgreSQL 中已提交的 journal/posting 是唯一金融事实；JetStream、日志、缓存和 go-like Store 都不是。
2. 每个 transaction 在数据库提交点至少有两条 posting，且按货币求和严格为零。
3. 金额全程使用十进制字符串与 PostgreSQL `bigint`，任何边界都不经过浮点数。
4. journal/posting 只能追加；纠错使用可追溯的冲正 transaction。
5. `(tenant_id, idempotency_key)` 唯一；同键同请求只产生一个 transaction 和一个 outbox event，同键异请求失败。
6. 幂等结果、账本和 outbox 必须在同一个 PostgreSQL transaction 中提交或回滚。
7. HTTP 成功响应只在 commit 成功后返回；未知 commit 结果必须先按幂等键回读，不能盲目重写。
8. Outbox 领取 transaction 短小，不在持锁或打开 transaction 时等待 NATS。
9. `published_at` 只在收到匹配 `eventId` 的 `PubAck` 后写入。
10. 跨 PostgreSQL 与 JetStream 的交付是 at-least-once；消费者按 `eventId` 去重，不能依赖 exactly-once 宣称。
11. 一个原生资源只有一个 lifecycle owner；先停止 HTTP 与 publisher，再 drain NATS connection、关闭数据库池。
12. 日志、错误和事件不得包含数据库 URL、凭据、幂等键原文或支付工具敏感数据。

## 故障场景与预期行为

| 场景                            | 预期行为                                                                                                       |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 同一键并发提交相同 body         | PostgreSQL 唯一键串行化结果；只存在一个 transaction、平衡 posting 集和 outbox event，其余请求重放已保存响应。  |
| 同一键提交不同 body             | 返回 `409`，不新增或修改账本。                                                                                 |
| schema/业务校验失败             | 在开启数据库 transaction 前返回 `400`；不得写入幂等、账本或 outbox。                                           |
| 数据库约束、连接或 commit 失败  | 返回失败且不报告入账成功；commit 结果不明时按幂等键 fresh readback。                                           |
| 写 posting 后进程崩溃           | PostgreSQL 原子回滚，或整笔 transaction 与 outbox 一起可见；不存在部分可见状态。                               |
| commit 后、publisher 领取前崩溃 | 未发布 outbox 留在 PostgreSQL，重启后继续领取。                                                                |
| NATS 断线或无 `PubAck`          | 不写 `published_at`；释放或等待 lease 过期后按 backoff 重试，账本 API 的已提交事实不回滚。                     |
| `PubAck` 后、标记前崩溃         | 允许重复发布；稳定 `eventId`、`msgID` 和消费者去重吸收重复。                                                   |
| Publisher 多副本竞争            | `SKIP LOCKED` 与 lease 减少同批竞争；lease 过期仍可能重复，因此下游去重保持必需。                              |
| outbox 持续积压                 | 以最老未发布年龄和未发布数量告警；达到经容量测试确定的安全上限时才启用显式流控，不静默丢事件。                 |
| 收到终止信号                    | 停止新 HTTP 请求，停止领取新 outbox，有限等待当前 publish；未完成记录仍在 PostgreSQL，随后关闭 NATS 与数据库。 |

## 真实 Docker 服务与版本策略

本地集成环境只需要两个真实服务，并都使用 named volume 验证重启持久性：

| 服务           | 镜像与启动要求                                                                                                                                                       | 版本策略                                                                                                                             |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| PostgreSQL     | `docker.io/library/postgres:18.4@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a`；独立用户、TCP readiness、named volume 和显式 migration。  | 运行时 fresh readback 为 PostgreSQL `18.4 (Debian 18.4-1.pgdg13+1)`；升级必须同时更新 tag、multi-arch digest、版本断言和持久化测试。 |
| NATS JetStream | `docker.io/library/nats:2.14.4-alpine@sha256:f2123f533c2b0cada0a5c5ec434fb2b8cfe1cf220215ef9d7517e1372917ad66`，启动参数至少包含 `-js -sd /data` 并挂载持久 volume。 | E2E 回读为 NATS Server `2.14.4`；NATS JS packages 固定为 `3.4.0`。升级时同时更新 tag、digest、版本断言和重连/JetStream E2E。         |

实现验收必须从运行中的容器回读 `SELECT version()`、`nats-server --version` 和 Docker image ID，不能只相信 tag。
开发凭据只用于隔离的本地网络；生产凭据通过部署环境注入，不写入 README、Compose 或日志。

## 验证

运行以下命令；本示例不生成 `dist`：

```bash
bun run --cwd examples/payments-ledger typecheck
bun run --cwd examples/payments-ledger test:unit
bun run --cwd examples/payments-ledger test:unit:coverage
bun run test:e2e:examples
```

Docker E2E 覆盖：并发同键请求收敛为 `1` 个幂等结果、`1` 个 transaction、`2` 条 posting 和 `1` 条
outbox；posting 总和为 `0`；不平衡 transaction 在 commit 时返回 SQLSTATE `23514`；NATS outage 时
`published_at` 保持空，恢复后真实 `PubAck` 才触发标记；PostgreSQL 与 NATS named volume 重启后数据仍在；
结束后按唯一 owner label fresh 回读 container `0`、volume `0`。

当前 E2E 没有模拟 `PubAck` 后、数据库标记前的进程崩溃，也没有做多 publisher 压测；这两项仍是扩展部署测试，
不能从当前结果外推为已经验证。

## 非目标

- 不实现支付授权、卡数据采集、清算、退款工作流、拒付、FX、税务或余额授信策略。
- 不提供通用会计平台、ORM、数据库迁移框架或新的 go-like SQL package。
- 不承诺 PostgreSQL 与 NATS 的分布式 exactly-once transaction，也不把 JetStream 当账本备份。
- 不为第一版增加 Redis、Kafka、CDC、事件溯源框架或全局事件顺序。
- 不在应用启动时自动执行生产 migration；生产 schema 变更由独立部署步骤负责。
