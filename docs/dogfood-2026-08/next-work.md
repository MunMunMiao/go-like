# 生产者下一轮 backlog

只列入**已有 dest 证据**的项。生产者 SHA 为 `cd15313d50e6804cfe34a7e7291cb65a861dec1c`。本表不授权修改 `packages/`、不启动 dest、不提交 git。

未列入：15 个未启动 ID（无 dest）；first-wave `MS-022` / `MS-033` / `MS-037` / `MS-039`（无 findings、无 verify）；12 个 `assertionsPassed=true` 的 dest（无 product finding）。通过 dest 的 DX 税见 [ux-summary.md](ux-summary.md)，不在此当作缺陷票。

提升规则与 [findings-catalog.md](findings-catalog.md) 相同：仅 go-like 失败且 competitor 通过，才可作为库工作；dual-fail **不得**提升为库缺陷。

---

## P0 — 可提升的 go-like 库缺口（对照已通过）

### NW-020

| 字段 | 值 |
| --- | --- |
| ID | NW-020（findings `MS-020-001` … `MS-020-006`） |
| package | `@go-like/transport-http` |
| dest | fw-r183 / `MS-020` |
| 为何下一轮做 | 六条 go-like 槽在 required-mTLS HTTP/2 上把冻结 REST `POST /v1/machine-commands` 答成 HTTP 200 载体 + `missing Go-Like-Service header`。同一 dest 上 competitor 六槽返回 HTTP 201 及 `peerIdentity spiffe://ms020/machine/alpha`。这是公共传输面对 REST 样本时缺的能力，不是应用没绑路由。 |
| 仍未核实 | 公共 API 是否**应该**接受无 `Go-Like-Service` 的原生 REST；`TransportInfo` 是否应暴露已验证 URI SAN / SPIFFE；`responseMessage` 将 carrierStatus 固定为 200 是契约还是缺陷；GET receipt 路径在本 dest 上未作为独立库断言跑通。禁止用原生 `http2` 监听器绕过公共 transport。 |

### NW-006

| 字段 | 值 |
| --- | --- |
| ID | NW-006（findings `MS-006-001` … `MS-006-006`） |
| package | `@go-like/broker-rabbitmq` |
| dest | fw-r214 / `MS-006` |
| 为何下一轮做 | `RecoveringRabbitMqBroker` 在健康网内 RabbitMQ 上挡住 `startRole` 的 HTTP 绑定，lending-desk `/healthz` 以 socket hang up 耗尽 60s。competitor `openBus` 后 `serveHttp` 在同一拓扑上成功。缺口发生在 first-service-startup，后续借贷路径从未发出。 |
| 仍未核实 | 健康 broker 上 setup 是否终能 `setupCompleted`，或 Infinity retry 会永久挡住；根因是 broker initial setup、AMQP/toxiproxy URL，还是 recovering 包装；库是否应在 setup 完成前提供可探测的 not-ready（200/503）而不要求应用先 `bindHttp`。先绑 HTTP 的应用 workaround 已被战役禁止。 |

### NW-009

| 字段 | 值 |
| --- | --- |
| ID | NW-009（findings `MS-009-001` … `MS-009-006`） |
| package | `@go-like/server` |
| dest | fw-r230 / `MS-009` |
| 为何下一轮做 | fault-worker 使用 `@go-like/server` 且无自定义 health handler，发布的 `/healthz` 持续 HTTP 500；ingest-gateway 自定义 handler 为 200。competitor 原生 HTTP `/healthz` 为 200。bootstrap 因此从未 POST `/v1/failure-correlations`。 |
| 仍未核实 | 500 来自缺省 handler、readiness fail-closed，还是未挂 health 实现；在公共 server 上登记 health 后是否即可变为 200/503；与 MS-006 同类的 recovering 阻塞是否也存在。不能把“应用自己写 `/healthz`”当成库已具备该能力。 |

---

## P1 — dual-fail dest，禁止当作库缺陷实现

下列项有 dest 证据，但两条实现都未通过该产品阶段。下一轮若处理，只能做隔离实验或文档澄清，不能合入“修复 `@go-like/*`”的结论。

### NW-011

| 字段 | 值 |
| --- | --- |
| ID | NW-011（go-like `MS-011-007` … `012`；competitor `MS-011-001` … `006`） |
| package | `@go-like/store-file`（对照侧 `node:fs/promises`） |
| dest | fw-r234 / `MS-011` |
| 为何记在表上 | go-like job-ingest 在 `waitForStore` 上报 `file store did not become running`，HTTP 未听。症状像 missing-capability，但 dest 级 dual-fail：competitor 走到 recovery scan 后漏掉 crash-lease job。 |
| 仍未核实 | store 路径、running 条件、权限与 host 配置；若 competitor 通过 bootstrap，go-like 是否仍失败；go-like 从未到达 `POST /v1/recovery/scan`，不能与对照漏扫对拍。**在出现 competitor 通过的 dest 之前，不得提升为库缺陷。** |

### NW-013

| 字段 | 值 |
| --- | --- |
| ID | NW-013（application `MS-013-007` … `012`；competitor `MS-013-001` … `006`） |
| package | `recon-gateway`（对照侧 `@nestjs/core`） |
| dest | fw-r239 / `MS-013` |
| 为何记在表上 | go-like 在 `/healthz` 已起后对 healthy fixture 返回 502；competitor 在 recon-gateway `/healthz` 即 `ECONNREFUSED`。行级 owner 已是 application / competitor。 |
| 仍未核实 | 502 的下游是 matcher、ledger 还是网关映射；是否与 `@go-like/web` 有关。**禁止提升为库缺陷。** |

### NW-016

| 字段 | 值 |
| --- | --- |
| ID | NW-016（`MS-016-001` … `012`） |
| package | 行级为 `@go-like/web` 与 `@hono/node-server`；dest 分类 dual-fail |
| dest | fw-r244 / `MS-016` |
| 为何记在表上 | 两侧 healthy-path 均通过；compose kill + start 后 `/livez` 全部 `ECONNREFUSED`。同一恢复步骤双侧失败。 |
| 仍未核实 | 是 compose 未真正把 intake/runtime 拉回、端口未重新发布，还是进程听在错误网络命名空间。**禁止把 `@go-like/web` 当作本 dest 的库根因。** |

### NW-017

| 字段 | 值 |
| --- | --- |
| ID | NW-017（`MS-017-001` … `012`） |
| package | 行级为 `@go-like/web` 与 `hono`；dest 分类 dual-fail |
| dest | fw-r245 / `MS-017` |
| 为何记在表上 | 与 NW-016 同构：healthy-path 通过，fault-matrix restore 后 application `/livez` `ECONNREFUSED`，四条车道都失败。 |
| 仍未核实 | 与 NW-016 是否同一 harness 恢复契约；workerd 角色是否需要比 60s 更长的 ready。**禁止提升。** |

### NW-018

| 字段 | 值 |
| --- | --- |
| ID | NW-018（`MS-018-001` … `012`） |
| package | 行级为 `@go-like/web` 与 `@kubernetes/client-node`；dest 分类 dual-fail |
| dest | fw-r247 / `MS-018` |
| 为何记在表上 | k3s healthy 之后，go-like 在 controller/ledger `/healthz` `ECONNREFUSED`，competitor 在 replica-a `/healthz` `ECONNREFUSED`（`announceReplica` 早于 listen）。失败角色不同，dest 仍 dual-fail。 |
| 仍未核实 | 顺序启动契约、k3s 内应用绑定与已发布端口的映射。**禁止提升为 `@go-like/web` 库缺陷。** |

---

## P2 — 仅 competitor 失败（不在 LikeGo 库队列）

### NW-010

| 字段 | 值 |
| --- | --- |
| ID | NW-010（`MS-010-001` … `MS-010-006`） |
| package | `@redis/client` |
| dest | fw-r231 / `MS-010` |
| 为何记在表上 | 有 dest 证据，且 go-like 对照通过。competitor fault-matrix 在 300ms 内 socket hang up。写入本表是为了避免被误收进库修复。 |
| 仍未核实 | hang up 发生在 Redis 客户端、应用 graceful-stop 还是 harness 探活。生产者无需为此改 `@go-like/*`。 |

---

## 建议顺序

1. `NW-020`：公共 HTTP 传输与 REST/SPIFFE 的缺口最清楚，对照完整。
2. `NW-006`：recovering broker 挡住 first listen，对照完整。
3. `NW-009`：默认 `/healthz` 500，对照完整。
4. 不要实现 `NW-011` / `NW-013` / `NW-016` / `NW-017` / `NW-018`，除非先有“对照通过”的新 dest。
5. `NW-010` 保持为对照记录。

验证修复时必须回到 `go-like-dogfood` 对应 dest 的 `evidencePaths`（各 finding 的 `stdout/healthy-path.log` 或 `stdout/fault-matrix.log`），而不是本目录的综述。
