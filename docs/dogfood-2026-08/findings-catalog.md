# Findings 目录

本目录按 `suspectedOwner` 再按 `package` 分组，覆盖 9 个失败 dest 上的 84 条 reproduced findings。行级字段见 [findings-index.json](findings-index.json)。原始 JSON 仍在各 dest 的 `projects/*/findings/`。

## dest 分类

| dest 分类 | 含义 | 可否提升为库缺陷 |
| --- | --- | --- |
| go-like | 仅 go-like 车道失败，同一 dest 上 competitor 通过 | 可以，仍须对照公共 API，禁止用应用 workaround 掩盖 |
| competitor | 仅 competitor 车道失败，同一 dest 上 go-like 通过 | 否（对照实现问题，不是 LikeGo 库队列） |
| application | 失败被记在应用角色或应用组装，而不是库 SPI | 否，除非后续 dest 把缺口隔离到公共包 |
| dual-fail | 同一 dest 上两条实现都未通过该产品阶段 | **否**。禁止把 dual-fail 提升为库缺陷 |

按 dest：

| project | dest | dest 分类 | go-like 阶段 | competitor 阶段 |
| --- | --- | --- | --- | --- |
| MS-006 | fw-r214 | go-like | healthy-path 失败 | 通过（含 fault-matrix） |
| MS-009 | fw-r230 | go-like | healthy-path 失败 | 通过（含 fault-matrix） |
| MS-010 | fw-r231 | competitor | 通过（含 fault-matrix） | fault-matrix 失败 |
| MS-011 | fw-r234 | dual-fail | healthy-path 失败 | healthy-path 失败（不同症状） |
| MS-013 | fw-r239 | dual-fail | healthy-path 失败 | healthy-path 失败（不同症状） |
| MS-016 | fw-r244 | dual-fail | fault-matrix 失败（healthy-path 已过） | 同左 |
| MS-017 | fw-r245 | dual-fail | fault-matrix 失败（healthy-path 已过） | 同左 |
| MS-018 | fw-r247 | dual-fail | healthy-path 失败 | healthy-path 失败 |
| MS-020 | fw-r183 | go-like | healthy-path 失败 | 通过（含 fault-matrix） |

MS-011 与 MS-013 虽症状不同，但 dest 级 `assertionsPassed=false` 同时落在两条实现上，仍按 dual-fail 处理，不得单独凭该 dest 提升库缺陷。

所有行：`status=reproduced`，`reproducibility=once`（每条车道重复 1/2/3 各一次）。kind 只有 `missing-capability` 与 `lifecycle`。无 `harness` / `environment` owner。

---

## suspectedOwner: go-like

### `@go-like/broker-rabbitmq`（dest 分类：go-like）

项目 `MS-006`，dest `fw-r214`，reviewer `DEV-07`，kind `missing-capability`，phase `healthy-path`，severity `blocker`。competitor 在同一 Compose 拓扑上 `openBus` 后 `serveHttp` 成功。

| id | lane | actual |
| --- | --- | --- |
| MS-006-001 … 003 | docker-go-like | `timed out waiting for http://127.0.0.1:40611/healthz: socket hang up` |
| MS-006-004 … 006 | local-go-like | `timed out waiting for http://127.0.0.1:40601/healthz: socket hang up` |

期望：`ensureSchema` 之后，`RecoveringRabbitMqBroker` 在健康的网内 RabbitMQ 上完成 initial setup，使 `startRole` 能绑定 HTTP，并在 60s bootstrap 窗口内让 `GET /healthz` 返回 200 或 503。

UX 补充：`startRole` 在 `bindHttp` 前等待 `openRecoveringBroker`；`RecoveringRabbitMqBroker` 在 `setupCompleted` 前阻塞，重试为 Infinity。未采用“先绑定 HTTP”的应用 workaround。

### `@go-like/server`（dest 分类：go-like）

项目 `MS-009`，dest `fw-r230`，reviewer `DEV-10`，kind `missing-capability`，phase `healthy-path`，severity `blocker`。competitor 原生 HTTP `/healthz` 在同一拓扑上返回 200。

| id | lane | actual |
| --- | --- | --- |
| MS-009-001 … 003 | local-go-like | `timed out waiting for http://127.0.0.1:40901/healthz: 500` |
| MS-009-004 … 006 | docker-go-like | `timed out waiting for http://127.0.0.1:40911/healthz: 500` |

期望：fault-worker 上 `@go-like/server` HTTP 监听的 `GET /healthz` 在 60s 内返回 200 或 503。

UX 补充：`ingest-gateway` 自定义 `/healthz` 为 200；fault-worker 使用 `@go-like/server` 且无自定义 health handler，发布端口持续 500。`APP_ROLES` 先起 fault-worker，因此 40901/40911 不是 ingest。

### `@go-like/store-file`（dest 分类：dual-fail，禁止提升）

项目 `MS-011`，dest `fw-r234`，reviewer `DEV-12`，kind `missing-capability`，phase `healthy-path`，severity `blocker`。同一 dest 上 competitor 也失败（见 `node:fs/promises`），且失败点更靠后。

| id | lane | actual 摘要 |
| --- | --- | --- |
| MS-011-007 … 009 | local-go-like | `41100/healthz` `ECONNREFUSED`；`Error: file store did not become running`（`waitForStore`） |
| MS-011-010 … 012 | docker-go-like | `41110/healthz` 同上 |

期望：job-ingest 的 `@go-like/store-file` host 进入 readable，从而在 60s 内监听 `GET /healthz`。HTTP 先监听被明确禁止，未采用。

不得把本组当作已证实的库缺陷：go-like 未到达 competitor 失败的 `POST /v1/recovery/scan`，缺少“对照通过”的 dest。

### `@go-like/transport-http`（dest 分类：go-like）

项目 `MS-020`，dest `fw-r183`，reviewer `DEV-01`，kind `missing-capability`，phase `healthy-path`，severity `blocker`。competitor 在同一 dest 上六槽均返回冻结 REST 201。

| id | lane | actual 摘要 |
| --- | --- | --- |
| MS-020-001 … 003 | local-go-like | HTTP 200 载体，body `missing Go-Like-Service header`（serviceStatus 400）；ALPN h2、TLS 1.3 已协商 |
| MS-020-004 … 006 | docker-go-like | 同上 |

期望：在 required-mTLS HTTP/2 上 `POST /v1/machine-commands` 返回 HTTP 201 及冻结成功体，含 `peerIdentity spiffe://ms020/machine/alpha`。

UX 补充：`newNodeHTTPTransport(clientAuth(require), allowHTTP1(false))` 能监听，但 `TransportInfo` 不暴露已验证 URI SAN；无 `Go-Like-Service` / `Go-Like-Endpoint` 的黑盒 REST POST 到不了 `machine-gateway/command`；unary `ServiceError` 的 carrierStatus 被要求为 200。未使用禁止的原生 `http2` 监听器作为 workaround。

---

## suspectedOwner: application

本组包名有的是应用角色（`recon-gateway`），有的是 `@go-like/web`，但 finding 把 owner 记为 application 而非 go-like。全部落在 dual-fail dest，禁止提升为库缺陷。

### `recon-gateway`（dest 分类：dual-fail）

项目 `MS-013`，dest `fw-r239`，reviewer `DEV-14`，kind `lifecycle`，phase `healthy-path`，severity `high`。

| id | lane | actual |
| --- | --- | --- |
| MS-013-007 … 009 | local-go-like | `healthy expected 200, got 502` |
| MS-013-010 … 012 | docker-go-like | 同上 |

期望：`recon-gateway` `GET /healthz` 就绪后，`POST /v1/reconciliations` 对 `fixtures/healthy-1001.json` 返回 200。UX：种子网关把非超时下游错误映射为 502；HTTP bind-first 未使用。同一 dest 上 competitor 在网关 `/healthz` 即 `ECONNREFUSED`。

### `@go-like/web`（dest 分类：dual-fail）

三份 finding 都把 package 写成 `@go-like/web`、owner 写成 `application`。症状是应用端口在 compose kill + start 或角色顺序启动后未能在 60s 内恢复 `/livez` 或 `/healthz`。competitor 在对应 dest 上以不同包名出现同一阶段失败。

| 项目 | dest | phase | ids | lane 与 actual 摘要 |
| --- | --- | --- | --- | --- |
| MS-016 | fw-r244 | fault-matrix | MS-016-007 … 009 | local-go-like：`41600/livez` `ECONNREFUSED` |
| MS-016 | fw-r244 | fault-matrix | MS-016-010 … 012 | docker-go-like：`41610/livez` `ECONNREFUSED` |
| MS-017 | fw-r245 | fault-matrix | MS-017-007 … 009 | local-go-like：`41700/livez` `ECONNREFUSED`（application port did not recover） |
| MS-017 | fw-r245 | fault-matrix | MS-017-010 … 012 | docker-go-like：`41710/livez` 同上 |
| MS-018 | fw-r247 | healthy-path | MS-018-007 … 008 | local-go-like：controller `41802/healthz` `ECONNREFUSED` |
| MS-018 | fw-r247 | healthy-path | MS-018-009 | local-go-like：ledger `41803/healthz` `ECONNREFUSED` |
| MS-018 | fw-r247 | healthy-path | MS-018-010 … 012 | docker-go-like：controller `41812/healthz` `ECONNREFUSED` |

MS-016 / MS-017 的 healthy-path 已在全部六槽通过；失败只在 restore。MS-018 在 k3s healthy 之后、靠后的 `APP_ROLES` 上失败（replica-a 不是 go-like 侧的失败点）。三者都不得记成 `@go-like/web` 库缺陷。

---

## suspectedOwner: competitor

### `@redis/client`（dest 分类：competitor）

项目 `MS-010`，dest `fw-r231`，reviewer `DEV-11`，kind `lifecycle`，phase `fault-matrix`，severity `high`。go-like 六槽 EXIT 0。

| id | lane | actual |
| --- | --- | --- |
| MS-010-001 … 003 | local-competitor | `socket hang up` |
| MS-010-004 … 006 | docker-competitor | `socket hang up` |

期望：competitor fault-matrix 在同一 Compose 拓扑上跑完 graceful-stop 到 cleanup。UX：挂起发生在 300ms 内；产品阶段回退仍标为 product。这不是 LikeGo 库队列。

### `node:fs/promises`（dest 分类：dual-fail）

项目 `MS-011`，dest `fw-r234`，reviewer `DEV-12`，kind `lifecycle`，phase `healthy-path`，severity `high`。

| id | lane | actual |
| --- | --- | --- |
| MS-011-001 … 003 | local-competitor | `recovery scan missed crash-lease job` |
| MS-011-004 … 006 | docker-competitor | 同上 |

期望：`POST /v1/recovery/scan` 在 executor run 之后把 crash-lease job 标为 recovered。competitor 已走过 submit/run/replay；go-like 未到达该断言。禁止用本组反推 `@go-like/store-file`。

### `@nestjs/core`（dest 分类：dual-fail）

项目 `MS-013`，dest `fw-r239`，reviewer `DEV-14`，kind `lifecycle`，phase `healthy-path`，severity `high`。

| id | lane | actual |
| --- | --- | --- |
| MS-013-001 … 003 | local-competitor | `41320/healthz` `ECONNREFUSED` |
| MS-013-004 … 006 | docker-competitor | `41330/healthz` `ECONNREFUSED` |

期望：channel-matcher 与 settlement-ledger 就绪后，recon-gateway 在已发布网关端口上 60s 内 `GET /healthz` 返回 200。matcher/ledger 的 healthz 已被接受。

### `@hono/node-server`（dest 分类：dual-fail）

项目 `MS-016`，dest `fw-r244`，reviewer `DEV-17`，kind `lifecycle`，phase `fault-matrix`，severity `high`。healthy-path 已过。

| id | lane | actual |
| --- | --- | --- |
| MS-016-001 … 003 | local-competitor | `41620/livez` `ECONNREFUSED` |
| MS-016-004 … 006 | docker-competitor | `41630/livez` `ECONNREFUSED` |

期望：intake/runtime 经 compose kill + compose start 后，60s 内 `GET /livez` 返回 200。与 go-like 侧同一 restore 失败，属 dual-fail。

### `hono`（dest 分类：dual-fail）

项目 `MS-017`，dest `fw-r245`，reviewer `DEV-18`，kind `lifecycle`，phase `fault-matrix`，severity `high`。healthy-path 已过。

| id | lane | actual |
| --- | --- | --- |
| MS-017-001 … 003 | local-competitor | application port `41720/livez` 未恢复，`ECONNREFUSED` |
| MS-017-004 … 006 | docker-competitor | `41730/livez` 同上 |

与 `@go-like/web` 在 MS-017 上的 restore 失败成对出现，禁止提升任一侧为库缺陷。

### `@kubernetes/client-node`（dest 分类：dual-fail）

项目 `MS-018`，dest `fw-r247`，reviewer `DEV-19`，kind `lifecycle`，phase `healthy-path`，severity `high`。

| id | lane | actual |
| --- | --- | --- |
| MS-018-001 … 003 | local-competitor | replica-a `41820/healthz` `ECONNREFUSED` |
| MS-018-004 … 006 | docker-competitor | replica-a `41830/healthz` `ECONNREFUSED` |

期望：compose start 后 replica-a 在 60s 内 `GET /healthz` 返回 200 或 503。UX：`announceReplica` 发生在 `listenState` 之前。go-like 侧失败点是后段 controller/ledger，不是 replica-a；仍是 dest 级 dual-fail。

---

## 计数

| dest 分类 | findings 条数 | 项目 |
| --- | ---: | --- |
| go-like（可提升候选） | 18 | MS-006、MS-009、MS-020 |
| competitor（仅对照） | 6 | MS-010 |
| dual-fail | 60 | MS-011、MS-013、MS-016、MS-017、MS-018 |
| 合计 | 84 | 9 个失败 dest |

dual-fail 的 60 条里，按行级 `suspectedOwner`：go-like 6（store-file）、application 24、competitor 30。行级 owner 不改变 dest 分类。
