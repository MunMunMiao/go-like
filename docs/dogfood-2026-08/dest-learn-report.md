# dest 学习报告（2026-08）

本文是 dest 学习结论，不是 40/40 战役完成声明。证据来自收获快照 `docs/dogfood-2026-08/` 与 `go-like-dogfood` 战役目录。本轮不修改 `packages/`、不启动 dest、不 compose、不提交 git。

结论先行：P0 `NW-020` / `NW-009` / `NW-006` 已在生产者 `a6d266718ac322fcb7cc4f5c87a3be46bfe53aff` 与 `43abe749cb9e05c56c99b07a3595dbdb8c2121a0` 落地。关闭 dest `fw-r252` / `fw-r253` / `fw-r254` 上 go-like 与 competitor 在同一产品阶段均通过。当前没有 go-like 失败且 competitor 通过的新证据。`docs-dx` 与 dest 样本 workaround 不得提升为库缺陷。

---

## 1. 范围（不是 40/40）

计划项目仍是 `MS-001` … `MS-040`，共 40 个。收获快照 [README.md](README.md) 与 [inventory.json](inventory.json) 记录的是生产者 SHA `cd15313d50e6804cfe34a7e7291cb65a861dec1c` 上的第一批产物，**不是** 40/40 全量关闭。

| 类别 | 数量 | 说明 |
| --- | ---: | --- |
| 计划项目 | 40 | `MS-001` … `MS-040` |
| 已接纳且含 `verify-*.json` | 21 | [SOURCE.md](SOURCE.md) 列出路径；四条车道 `admittedRepetitions` 均为 `[1,2,3]` |
| 其中 `assertionsPassed=true` | 12 | 无 product finding |
| 其中 `assertionsPassed=false` | 9 | 84 条 reproduced findings |
| first-wave（无 verify） | 4 | `MS-022` / `MS-033` / `MS-037` / `MS-039`，仅 `project-cleanup.json` |
| 未启动 | 15 | 无 `2026-08-microservices-fw-r*` dest |
| 本轮关闭 dest | 3 | `fw-r252`（`MS-020`）、`fw-r253`（`MS-009`）、`fw-r254`（`MS-006`） |

未启动 ID：`MS-019`、`MS-021`、`MS-023`、`MS-024`、`MS-026`、`MS-028`、`MS-029`、`MS-030`、`MS-031`、`MS-032`、`MS-034`、`MS-035`、`MS-036`、`MS-038`、`MS-040`。无 dest 即无提升资格。

9 个失败 dest 的原始路径：

| project | dest | dest 分类 | verify |
| --- | --- | --- | --- |
| `MS-006` | `fw-r214` | go-like | `/Users/munmunmiao/Documents/web/go-like-dogfood/campaigns/2026-08-microservices-fw-r214/projects/MS-006/verify-MS-006.json` |
| `MS-009` | `fw-r230` | go-like | `.../fw-r230/projects/MS-009/verify-MS-009.json` |
| `MS-010` | `fw-r231` | competitor | `.../fw-r231/projects/MS-010/verify-MS-010.json` |
| `MS-011` | `fw-r234` | dual-fail | `.../fw-r234/projects/MS-011/verify-MS-011.json` |
| `MS-013` | `fw-r239` | dual-fail | `.../fw-r239/projects/MS-013/verify-MS-013.json` |
| `MS-016` | `fw-r244` | dual-fail | `.../fw-r244/projects/MS-016/verify-MS-016.json` |
| `MS-017` | `fw-r245` | dual-fail | `.../fw-r245/projects/MS-017/verify-MS-017.json` |
| `MS-018` | `fw-r247` | dual-fail | `.../fw-r247/projects/MS-018/verify-MS-018.json` |
| `MS-020` | `fw-r183` | go-like | `.../fw-r183/projects/MS-020/verify-MS-020.json` |

84 条 finding 的行级索引在 [findings-index.json](findings-index.json)，分组在 [findings-catalog.md](findings-catalog.md)。通过 dest 的 DX 税在 [ux-summary.md](ux-summary.md)，不计入产品缺陷票。

关闭 dest `fw-r252` / `fw-r253` / `fw-r254` **没有** `verify-*.json`。关闭证据是各 dest 的 12 槽 run（四条车道 × 重复 1/2/3）、`journal.md` `gate=1`、`project-cleanup.json` `passed=true`、`ux/golike.json` 与 `ux/competitor.json` 声明无 product-classified failure、以及不存在 `findings/`。这三 dest 关闭的是既有 P0 项目的对照回归，不把未启动 15 项或 dual-fail 五项算进完成。

战役根目录：`/Users/munmunmiao/Documents/web/go-like-dogfood/campaigns`。项目路径模式：`{campaigns}/2026-08-microservices-{dest}/projects/{projectId}/`。

---

## 2. 提升规则

与 [findings-catalog.md](findings-catalog.md) 及 [next-work.md](next-work.md) 相同。仅当**同一 dest、同一产品阶段**上 go-like 失败且 competitor 通过时，才可将 `suspectedOwner=go-like` 的项提升为库工作。提升后仍须对照公共 API；禁止用应用 workaround 或改 dest 样本冒充库已具备该能力。

| dest 分类 | 含义 | 可否提升为库缺陷 |
| --- | --- | --- |
| go-like | 仅 go-like 车道失败，同一 dest 上 competitor 通过 | 可以，仍须对照公共 API |
| competitor | 仅 competitor 车道失败，同一 dest 上 go-like 通过 | 否 |
| application | 失败记在应用角色或组装，而不是库 SPI | 否，除非后续 dest 把缺口隔离到公共包 |
| dual-fail | 同一 dest 上两条实现都未通过该产品阶段 | **否** |
| dest-harness | 探活客户端、AbortSignal、镜像 tag、锁文件摊平、TCP-accept-before-listen 等 dest 控制条件 | **否** |
| docs-dx | 通过 dest 上的安装/文档/端口心智税，无 product finding | **否** |
| dest 样本 workaround | dest 为通过战役而保留的样本侧等待、旁路或禁止项 | **否** |

行级 `suspectedOwner` 不覆盖 dest 分类。`MS-011` 的 go-like 行写 `@go-like/store-file`，competitor 行写 `node:fs/promises`，dest 仍 dual-fail。`MS-016` / `MS-017` / `MS-018` 的 go-like 行写 `@go-like/web` 且 owner 为 `application`，同样不得升库。

84 条 reproduced finding 的 kind 只有 `missing-capability` 与 `lifecycle`。catalog 明确：这些行没有 `harness` / `environment` owner。更早 dest 上被标为 harness 的失败不得事后改写成库票。

禁止项：

1. 把 dual-fail 的一侧症状单独提升。
2. 把 competitor-only 失败（`NW-010` / `fw-r231`）收进 `@go-like/*` 队列。
3. 把 [ux-summary.md](ux-summary.md) 的 DX 税写成库缺口。
4. 用 dest 样本 bind-first、原生 `http2` 监听器、自定义 `/healthz` 旁路来“证明”库已修复。
5. 在没有 dest 证据的 15 个未启动 ID 上发明库工作。

---

## 3. 已在 `43abe749` 落地

生产者日志：

| SHA | 提交说明 | 覆盖的 P0 |
| --- | --- | --- |
| `cd15313d50e6804cfe34a7e7291cb65a861dec1c` | 收获快照冻结 SHA | 失败 dest 的 goLikeSha |
| `a6d266718ac322fcb7cc4f5c87a3be46bfe53aff` | `feat: add REST httpRoute, recovering admit, and default /healthz` | `NW-020` 路径路由、`NW-006` recovering 接纳、`NW-009` 缺省 `GET /healthz` |
| `43abe749cb9e05c56c99b07a3595dbdb8c2121a0` | `fix: map httpRoute ServiceError to HTTP carrier status` | `NW-020` REST 载体状态（201 而不是信封 200） |

当前 `main` 指向 `43abe749`，包含 `a6d2667`。契约原文：

- `NW-020`：[nw-020-contract.md](nw-020-contract.md)，冻结失败 dest `fw-r183` / `MS-020`
- `NW-009`：[nw-009-contract.md](nw-009-contract.md)，冻结失败 dest `fw-r230` / `MS-009`
- `NW-006`：[nw-006-contract.md](nw-006-contract.md)，冻结失败 dest `fw-r214` / `MS-006`

冻结失败形状（不得用关闭 dest 改写历史）：

- `MS-020-001.json` … `006`：`POST /v1/machine-commands` 在 required-mTLS HTTP/2 上得到 HTTP **200** 载体 + `missing Go-Like-Service header`。workaround 原文：公共 unary 成功硬编码 200；`receiveRequest` 要求 POST；路由走 `Go-Like-Service` / `Go-Like-Endpoint` 而不是 URL path；`TransportInfo` 不暴露 URI SAN；go-like 车道禁止原生 `http2` 监听器。路径：`/Users/munmunmiao/Documents/web/go-like-dogfood/campaigns/2026-08-microservices-fw-r183/projects/MS-020/findings/MS-020-001.json`。
- `MS-009-001.json` … `006`：`fault-worker` `GET /healthz` 持续 HTTP **500**。workaround 原文：`fault-worker` 经 `@go-like/server` + `@go-like/transport-http` 无自定义 `/healthz`；禁止 bind-first。路径：`.../fw-r230/projects/MS-009/findings/MS-009-001.json`。
- `MS-006-001.json` … `006`：`lending-desk` `/healthz` `socket hang up`。workaround 原文：公共 `RecoveringRabbitMqBroker` 等到 `setupCompleted` 才返回；`startRole` 在其后才 `bindHttp`；禁止先绑 HTTP。路径：`.../fw-r214/projects/MS-006/findings/MS-006-001.json`。

落地含义：

1. `@go-like/transport-http` / `@go-like/server` 接纳无信封 REST 路径路由；`httpRoute` 的 `ServiceError` 映射到 HTTP 载体状态。`43abe749` 关闭 dest `fw-r252` 上 `POST /v1/machine-commands` 返回 HTTP **201** 及 `peerIdentity spiffe://ms020/machine/alpha`。
2. `@go-like/server` 缺省 `GET /healthz` 为 200 或 503。`a6d2667` 关闭 dest `fw-r253` 上 `fault-worker` 发布端口不再 500。
3. `@go-like/broker-rabbitmq` recovering 入口在 initial setup 完成前可接纳，使 dest 能在 connector 返回后 `bindHttp`。`a6d2667` 关闭 dest `fw-r254` 上 `/healthz` 不再 `socket hang up`。

这三票已经完成授权范围内的库工作。关闭 dest 没有对生产者再打补丁：`fw-r252` UX `recovery-from-the-failure` 写明 “No producer patch was applied on this dest”；`fw-r253` / `fw-r254` 同句。

---

## 4. dest `fw-r252` / `fw-r253` / `fw-r254` 状态

三条关闭 dest 都是四条车道、每车道重复 1/2/3，共 12 槽。`journal.md` 每槽 `status=0 cleanup=0 shutdown=0 gate=1`。`ux/golike.json` 与 `ux/competitor.json` 的 `first-failure-and-diagnosis` 均声明无 product-classified failure、无 library finding。不存在 `findings/`。无 go-like-fail / competitor-pass 形状。

### `fw-r252` / `MS-020`

| 项 | 值 |
| --- | --- |
| 路径 | `/Users/munmunmiao/Documents/web/go-like-dogfood/campaigns/2026-08-microservices-fw-r252/projects/MS-020/` |
| `campaign.json` producer.sha | `43abe749cb9e05c56c99b07a3595dbdb8c2121a0` |
| 项目 `manifest.json` producerSha | 同上 |
| baseline | `.../fw-r252/baseline/go-like/43abe749cb9e05c56c99b07a3595dbdb8c2121a0/` |
| `project-cleanup.json` | `passed=true`（`checkedAt` `2026-08-22T05:38:29.683Z`） |
| 产品阶段 | go-like 与 competitor 的 `healthy-path` / `invariants` / `fault-matrix` 均 `outcome=passed` |

go-like `first-inter-service-call`：`POST /v1/machine-commands` 六槽 HTTP 201，成功体含 `peerIdentity spiffe://ms020/machine/alpha`、`protocol h2`。`first-service-startup`：`newServer` + required mTLS、TLS 1.3、ALPN `h2`；缺省 `GET /healthz` 为 200。competitor 六槽同样 typecheck-build 到 cleanup，含未授权 403、HTTP/1.1 拒绝、command-proxy 1000ms 延迟时网关 504。

相对冻结 dest `fw-r183`：同一产品阶段从 go-like 失败 / competitor 通过，变为双侧通过。

### `fw-r253` / `MS-009`

| 项 | 值 |
| --- | --- |
| 路径 | `/Users/munmunmiao/Documents/web/go-like-dogfood/campaigns/2026-08-microservices-fw-r253/projects/MS-009/` |
| producer SHA | `a6d266718ac322fcb7cc4f5c87a3be46bfe53aff` |
| baseline | `.../fw-r253/baseline/go-like/a6d266718ac322fcb7cc4f5c87a3be46bfe53aff/` |
| `project-cleanup.json` | `passed=true`（`checkedAt` `2026-08-22T05:57:31.030Z`） |
| 产品阶段 | 双侧 `healthy-path` / `invariants` / `fault-matrix` 均通过 |

go-like `first-service-startup`：`ingest-gateway`、`fault-worker`、`signal-correlator` 在 postgres / etcd / otelcol / toxiproxy 上启动；宿主发布 `/healthz` 六槽接纳。`first-inter-service-call`：correlation receipts 与 traces 到达 dest oracle。无 product finding。

相对冻结 dest `fw-r230`：`fault-worker` 不再以 HTTP 500 耗尽 60s bootstrap。

### `fw-r254` / `MS-006`

| 项 | 值 |
| --- | --- |
| 路径 | `/Users/munmunmiao/Documents/web/go-like-dogfood/campaigns/2026-08-microservices-fw-r254/projects/MS-006/` |
| producer SHA | `a6d266718ac322fcb7cc4f5c87a3be46bfe53aff` |
| baseline | `.../fw-r254/baseline/go-like/a6d266718ac322fcb7cc4f5c87a3be46bfe53aff/` |
| `project-cleanup.json` | `passed=true`（`checkedAt` `2026-08-22T06:14:29.984Z`） |
| 产品阶段 | 双侧 `healthy-path` / `invariants` / `fault-matrix` 均通过 |

go-like `first-service-startup`：dest `node:http` 在 recovering broker 接纳之后 listen；宿主发布 `/healthz` 六槽接纳。`first-real-infrastructure-integration`：`startRecoveringRabbitMqBroker` 在 HTTP listen 之前接纳。无 product finding。

相对冻结 dest `fw-r214`：`lending-desk` `/healthz` 不再 `socket hang up`。

`fw-r255` 不存在。本轮没有第四条关闭 dest。

---

## 5. 剩余已授权项

**无。** 学习候选在怀疑过滤后为空。

[next-work.md](next-work.md) 原 P0 三票（`NW-020` / `NW-006` / `NW-009`）已由 `a6d2667` + `43abe749` 关闭，且关闭 dest 给出对照通过。下列项**从未**获得“go-like 失败且 competitor 通过”授权，关闭 dest 也没有把它们变成授权：

| ID | dest | 为何仍未授权 |
| --- | --- | --- |
| `NW-011` | `fw-r234` / `MS-011` | dual-fail；go-like 未到 `POST /v1/recovery/scan` |
| `NW-013` | `fw-r239` / `MS-013` | dual-fail；行级 owner 已是 application / competitor |
| `NW-016` | `fw-r244` / `MS-016` | dual-fail；compose kill + start 后双侧 `/livez` `ECONNREFUSED` |
| `NW-017` | `fw-r245` / `MS-017` | dual-fail；与 `NW-016` 同构 |
| `NW-018` | `fw-r247` / `MS-018` | dual-fail；失败角色不同，dest 级仍双侧失败 |
| `NW-010` | `fw-r231` / `MS-010` | 仅 competitor；go-like 六槽 EXIT 0 |
| first-wave 四项 | `fw-r25` / `fw-r73` / `fw-r109` / `fw-r12` | 无 `verify-*.json`，无 findings |
| 未启动 15 项 | 无 dest | 无证据 |

不得把“剩余未跑完的 40 项”写成剩余库授权。授权来自 dest 对照，不来自花名册空位。

---

## 6. 拒绝 dest-harness 与 dual-fail

### dest-harness

84 条 reproduced finding **没有** `harness` owner。更早 dest 与通过 dest 的 UX 里，下列项已被标为 dest / harness 控制条件，禁止提升：

| 现象 | 证据 | 拒绝理由 |
| --- | --- | --- |
| `AbortSignal.timeout` 在 settle 前 destroy，表现为 socket hang up | [ux-summary.md](ux-summary.md) `MS-008`；更早 dest `fw-r219`–`fw-r223` | 探活客户端竞态，不是库 SPI |
| `nodeHttpFetch` abort；competitor checkout hang | `MS-008` 更早 dest | later-src abort-on-close，双侧或对照源问题 |
| reminder-read / replay GET 立刻 404 | `MS-007` 更早 dest；异步 BullMQ upsert | 两侧都失败后归 harness |
| Node 26 `undici` `fetch failed`；Dockerfile `node -e` 花括号 | `MS-004` | dest 探活客户端与镜像脚本 |
| Docker Desktop 发布端口 TCP-accept-before-listen | `MS-002` / `MS-006` / `MS-007` / `MS-008`；`fw-r252` surprise 仍在 | dest 必须等 TLS/`h2` 或网内 DNS，不是库 listen API |
| Toxiproxy 内存表在 docker restart 后为空 | `fw-r252` UX `recovery-from-the-failure` | dest 自有代理表，dest 负责重建 |
| 冻结闭包 nested `@types/node`、lockfile 键必须对齐 tarball sha512 | `ux-summary.md`；`fw-r252` / `fw-r253` installation surprise | dest 打包形状，不是运行时缺口 |
| `IMPLEMENTATION_IMAGE` 缺失 tag 去 pull | `MS-007` | dest 镜像契约 |
| SIGTERM 残留、`waitForPortFree`、`compose start` 而非 `--force-recreate` | `MS-001` / `MS-002` / `MS-004` / `MS-006` competitor UX | dest 生命周期控制，cleanup 不得把产品阶段判负 |

dest harness 接受集是 `GET /healthz` **200 或 503**、60s bootstrap（契约引用 dest `scripts/lane-runtime.mjs`）。这是 dest 探活，不是要求 broker / store 包发明探针。把 harness 超时改写成库缺陷，等于把 dest 时钟卖给公共 API。

`MS-010-001.json` 明确：competitor fault-matrix `socket hang up` **不得**再分类为 harness；它仍是对照实现问题，因此也不进入库队列。

### dual-fail

| dest | findings | 双侧失败阶段 | 为何不得升库 |
| --- | --- | --- | --- |
| `fw-r234` / `MS-011` | 12 | healthy-path | go-like `waitForStore` `file store did not become running`；competitor `recovery scan missed crash-lease job`。无对照通过。workaround：禁止 bind-first。`MS-011-007.json` |
| `fw-r239` / `MS-013` | 12 | healthy-path | go-like healthy fixture **502**；competitor 网关 `/healthz` `ECONNREFUSED`。症状不同，dest 级仍 dual-fail |
| `fw-r244` / `MS-016` | 12 | fault-matrix（healthy-path 已过） | 双侧 compose kill + start 后 `/livez` `ECONNREFUSED`。`MS-016-007.json` owner=`application` |
| `fw-r245` / `MS-017` | 12 | fault-matrix（healthy-path 已过） | 与 `MS-016` 同构 |
| `fw-r247` / `MS-018` | 12 | healthy-path | go-like 败在 controller/ledger；competitor 败在 replica-a `announceReplica` 早于 listen |

dual-fail 60 条：行级 owner go-like 6（store-file）、application 24、competitor 30。行级数字不授权修复 `@go-like/store-file` 或 `@go-like/web`。关闭 dest 没有重跑这五项；它们保持拒绝。

---

## 7. dest 样本仍在规避的事项

关闭 dest 的 UX `workaroundLines` 均为 0：没有采用战役禁止的 bind-first 或原生 `http2` 旁路。样本**仍然**靠 dest 侧控制条件通过。这些不得提升为库工作。

### 关闭 dest 上仍保留的 dest 控制

1. **`MS-020` / `fw-r252`**：dest 在已发布网关 TCP 可 accept 之后，仍等待 TLS 1.3 ALPN `h2` 的 `/healthz`。docker 车道只发布 gateway；directory / command 留在内部 `:9443`。fault-matrix 的 hops 走 dest 所有的 Toxiproxy 2.12.0。docker restart 后 dest 重建 toxiproxy 内存代理表，再跑 reserved recovery `cmd-1007`。go-like 车道继续禁止原生 `http2.createSecureServer` 作为公共监听面。
2. **`MS-009` / `fw-r253`**：`ingest-gateway` 仍是 dest 样本既有的原生 `node:http` 自定义 `GET /healthz` 200（冻结源 `implementations/go-like/src/gateway.ts`）。这不是 `@go-like/server` 缺省面，不得改成“库已有自定义 health ABI”。dest 从 packed tarball 安装，lockfile 必须匹配 sha512；`copy-go-like` 未改写 lockfile。
3. **`MS-006` / `fw-r254`**：dest 样本仍在 recovering broker **接纳之后**才 `listen` dest `node:http`，并继续静态 `/healthz` 200。库票关闭的是“构造函数挡住 listen”，不是把 dest 改成 bind-first。dest-in-container 发布 TCP 仍可能早于 HTTP 接纳 `/healthz`；dest 继续等 HTTP 而不是 TCP。Postgres / RabbitMQ / toxiproxy 仍为 dest 所有。

### 通过 dest 上已被战役消化、仍不应写进库 API 的 workaround

来源：[ux-summary.md](ux-summary.md) 与各已接纳 dest 的 `projects/*/ux/`。

| dest 样本仍做什么 | 代表 dest | 为何不升库 |
| --- | --- | --- |
| `flattenNestedTypesNode` / 摊平 nested `@types/node` lock 键 | `MS-001`、`MS-002`、`MS-004`、`MS-005`、`MS-007`、`MS-008`、`MS-020`、`MS-027` | 冻结 vendor 闭包的 DX 税 |
| 角色加入 Compose 网络，经 toxiproxy DNS 访问基础设施，不走 Desktop 发布端口 | `MS-002`、`MS-006`、`MS-007`、`MS-008`、`MS-004` | 战役控制拓扑 |
| 探活用 `node:http` 而不是 undici `fetch` | `MS-004` | Node 26 dest 客户端 |
| `nodeHttpFetch` 先 settle 再让 `AbortSignal` destroy | `MS-008` | dest 探活 |
| SIGTERM 后 SIGKILL reap 残留进程组；cleanup 失败不得判负产品阶段 | `MS-001`、`MS-002` | dest cleanup |
| restore 前 `waitForPortFree` | `MS-004` | dest 生命周期 |
| `compose start` 而不是 `up --force-recreate`（后者丢掉 Compose DNS） | `MS-006` competitor UX | dest compose 契约 |
| 复用 healthy idempotency key，避免 UNIQUE `rol-1001` 双侧 502 | `MS-004` | dest fixture |
| 等 BullMQ worker upsert 后再 GET reminder | `MS-007` | 异步入队，立刻 GET 双侧 404 |
| competitor 先 `ListenAndServe` 再后台重试 `CampaignLoop` | `MS-027` | 对照启动顺序，不是 etcd 库 KeepAlive |

战役明确禁止、关闭 dest 也未采用的 workaround：HTTP bind-first；go-like 车道原生 `http2` 监听器；把 dest 应用改成第二套 health ABI 来掩盖 unary 缺省面。

---

## 8. 结论

本轮 dest 学习的可提升库缺口只有原 P0 三票，且已在 `a6d2667` + `43abe749` 落地。`fw-r252` / `fw-r253` / `fw-r254` 证明：在同一产品阶段，go-like 与 competitor 均可从 typecheck-build 走到 cleanup。没有新的 go-like-fail / competitor-pass 证据。

dual-fail、competitor-only、dest-harness、docs-dx、dest 样本 workaround、first-wave 无 findings、以及 15 个未启动 ID，全部保持拒绝。生产者下一轮若再开库票，必须先有新 dest 把缺口隔离成“仅 go-like 失败且对照通过”。在那之前，不得借本目录扩大 `packages/` 范围。
