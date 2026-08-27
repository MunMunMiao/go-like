# UX 摩擦摘要

行集来自 21 条含 verify 的已接纳 dest 上的 `ux/golike.json` 与 `ux/competitor.json`。first-wave 四条 dest 也有 UX 文件，但未进入本收获行集。工作区 `/Users/munmunmiao/Documents/web/likego/ux/` 不存在对照文件。

安装与 `tsc` 在已记录的 go-like dest 上普遍完成；重复摩擦集中在冻结闭包、Docker Desktop 发布端口、启动/恢复顺序，以及 REST 与 go-like 服务信封的心智差。通过 dest 的 surprise 仍然有用，因为它们解释了哪些 workaround 已经被战役侧消化、不应再写进库 API。

## 冻结 vendor 闭包与 nested `@types/node`

出现在 `MS-001`、`MS-002`、`MS-004`、`MS-005`、`MS-007`、`MS-008`、`MS-020`、`MS-027` 的 `installation-and-first-import`。

冻结 bundle-repo 拒绝 `@go-like/*` 下嵌套的 `@types/node` lock 键，直到 `flattenNestedTypesNode` / `scripts/flatten-nested-types.mjs` 把 lockfile 摊平到已登记的包键。`MS-027` 还出现过 project-manifest 登记 13 个 `@go-like` 名、车道 lockfile 根却只列出实际 import 的 8 个包而被拒。

这是重复的 DX 税，不是本轮 84 条 product findings 的直接原因。生产者若保持冻结闭包，需要把摊平变成默认发布形状，而不是每个 dest 脚本补一次。

## Docker Desktop 发布端口对宿主机 Node 不可用

出现在 `MS-002`、`MS-006`、`MS-007`、`MS-008` 以及 `MS-004` 的端口映射修正。

重复观察：

- 发布到宿主机的 Redis / AMQP 无法完成 host Node 握手；Compose 网络内 `toxiproxy:16379` / `toxiproxy:15671` 可以。
- docker-go-like 常常不把 etcd 发到宿主机；等待 `127.0.0.1:.../health` 会碰到 docker-proxy TCP-accept-before-listen。
- 应用 HTTP 同样不安全走 Desktop 发布端口；网内 `compose exec` 与 toxiproxy DNS 才稳定。
- `MS-004` 最初只发布 toxiproxy admin，host `pingPostgres` 在 `postgresProxyPort` 上 `ECONNREFUSED`，直到映射 `15432`/`12379`。

战役已经把“角色加入 Compose 网络、经 toxiproxy DNS 访问基础设施”当成控制条件。库文档若继续示范 `localhost` 发布端口，会与这次 dogfood 的真实拓扑相反。

## 禁止 HTTP bind-first，recovering 适配器挡住 `/healthz`

`MS-006`、`MS-009`、`MS-011` 的失败 UX 与三条可对照或 dual-fail 的启动缺口对齐。战役明确禁止“先绑 HTTP 再做 recovering setup”的应用 workaround。

| 项目   | 实现    | 现象                                                                                                                                    |
| ------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| MS-006 | go-like | `startRole` 等待 `openRecoveringBroker` 才 `bindHttp`；lending-desk `/healthz` socket hang up。competitor `openBus` 后 `serveHttp` 通过 |
| MS-009 | go-like | fault-worker `@go-like/server` 默认 `/healthz` 持续 500；ingest-gateway 自定义 handler 为 200                                           |
| MS-011 | go-like | `waitForStore` 报 `file store did not become running`，HTTP 未听                                                                        |
| MS-020 | go-like | transport 已听 TLS/h2，但 REST 黑盒调用被服务信封挡住                                                                                   |

开发者能完成 `npm ci` 与 `tsc`，却在“第一个 `/healthz` 或第一记 REST POST”上停住。这是本轮最尖的 first-service-startup 摩擦。

## Node 26、undici、AbortSignal 与 harness 误杀

通过 dest 里多次出现、且曾烧掉更早 dest 的运行时摩擦：

- `MS-004`：Node 26.7.0 把 Dockerfile `node -e` 中的花括号当成 TypeScript；undici `fetch` 使 healthz 探活变成 `fetch failed`，后改 `node:http`。
- `MS-005` competitor：Node 26 在读完 body 后把 `IncomingMessage` 标为 `req.destroyed`，若因此跳过 `res.end` 会丢掉全部 POST 响应。
- `MS-008`：`AbortSignal.timeout` 的 destroy 会表现为 socket hang up，除非 `nodeHttpFetch` 先 settle；更早 dest `fw-r219`–`r223` 因此被标为 harness 而非产品。
- `MS-008` competitor：Node 26 下 POST handler 开始时 `request.complete` 为 false，`close && !complete` 会在读 JSON 前中止 checkout。独立审查未把它记成 cockatiel 库缺陷。

这些项没有进入 84 条 findings，但说明“产品失败”之前必须先排除 Node 26 与探活客户端的误报。

## compose kill + start 后 `/livez` 双失败

`MS-016`（fw-r244）与 `MS-017`（fw-r245）：四条车道的 healthy-path 均通过；fault-matrix 在 compose kill + compose start 之后，已发布角色端口上 `GET /livez` 全部 `ECONNREFUSED`。go-like 记 `@go-like/web` / application，competitor 记 `@hono/node-server` 或 `hono`。

这是重复的恢复 DX：进程杀灭后的再监听没有在 60s 内出现。因为两侧同时失败，不能从本 dest 推断 `@go-like/web` 缺能力。更早的 `MS-006` competitor 还记录过：对 local 角色 `compose up --force-recreate` 会丢掉 Compose DNS，直到改用 `compose start`；`SIGTERM` + `docker rm` + 无 `--no-deps` 的 `compose create` 会丢掉网关端口。

## SIGTERM 残留、清理身份、镜像 tag

出现在通过 dest 的 graceful-shutdown / recovery surprise：

- `MS-001`：SIGTERM 让 ingest 保持 down，forced-stop 必须先 restore 再 SIGKILL；`docker stop -t 5` 可能留下 wx connection marker，挡住重启。
- `MS-002`：SIGTERM 后进程组仍对 `kill -0` 为真；cleanup 要求 TERM 后进程身份不变，残留组必须在冻结 CLI 前 SIGKILL reap，且 reap 失败不得把产品阶段判负。
- `MS-004`：SIGTERM restore 可能探到正在退出的 listener，需要 `waitForPortFree` 再 respawn。
- `MS-007`：`compose create` 若本地没有 `IMPLEMENTATION_IMAGE` tag 会去 pull 并烧掉 dest；`mocked(options)=typeof execute===function` 曾把活的 docker execute wrapper 当成 mock 而跳过 `docker build`。
- `MS-005` competitor：`consumer.consume().close()` 不迭代会挂在 `iterClosed`。

这些是生命周期 DX，不是本轮 go-like blocker 的直接证据。

## REST 信封、健康检查语义、基础设施心智

- **服务信封 vs 冻结 REST**：`MS-020` 黑盒 `POST /v1/machine-commands` 需要 `Go-Like-Service` / `Go-Like-Endpoint`。缺少时得到 HTTP 200 载体 + `invalid_request` 400。competitor 返回 HTTP 201。`TransportInfo` 不暴露 SPIFFE URI SAN。这是公共 HTTP 传输与 REST 样本之间最大的心智落差。
- **健康检查值**：样本接受 200 或 503；`MS-009` 默认 500 被当成失败；`MS-020` competitor 必须等 h2 session 而不能只等 TCP；`MS-027` competitor 必须先 `ListenAndServe` 再在后台重试 `CampaignLoop`，否则 etcd 未就绪会直接退出进程。
- **`@go-like/store-etcd`**：`MS-027` 记录它经 JSON gRPC gateway 为每次 write 发 etcd lease，并且不 keepalive / watch / elect；leader TTL 靠重写新 lease 续期。文档若暗示 KeepAlive 或选举，会与公共能力不符。
- **异步 worker 与立刻 GET**：`MS-007` 上 `POST /v1/reminders/scan` 只入队，立刻 GET 在 go-like 与 competitor 上都是 404，直到 BullMQ worker upsert。更早 dest 把 “reminded vs already-reminded” 和 reminder-read 判负，后被归为 harness（两侧都失败）。

## 按 checkpoint 的分布（含 verify 的 dest）

| checkpoint                            | 主要信号                                                                                        |
| ------------------------------------- | ----------------------------------------------------------------------------------------------- |
| installation-and-first-import         | 冻结闭包 + nested `@types/node`；安装本身很少失败                                               |
| first-service-startup                 | recovering broker/store、默认 `/healthz` 500、mTLS 已听但 REST 不到达 handler                   |
| first-inter-service-call              | MS-020 缺信封头；MS-013 网关 502；MS-007 scan 后异步 upsert                                     |
| first-real-infrastructure-integration | 必须走 Compose DNS / toxiproxy；Desktop 发布端口不可用                                          |
| first-failure-and-diagnosis           | 通过 dest 能从 stdout 诊断 400/409/413/499/504；失败 dest 往往停在 bootstrap                    |
| recovery-from-the-failure             | 通过 dest 能封住 postgres/nats/etcd/toxiproxy 故障；MS-016/017 在 compose kill+start 上双侧失败 |
| graceful-shutdown                     | SIGTERM 残留与 marker；cleanup 在通过 dest 上最终清掉 compose/端口/volume                       |
| full-docker-execution                 | docker-go-like 能跑完整产品路径（例如 MS-001），但依赖 in-network 而不是宿主机端口              |

## 明确没有当成 go-like 库问题的 UX

下列在笔记里被标为 harness、双侧失败或对照实现问题，不得在下一轮“顺手”提升：

- `MS-007` 更早 dest：镜像 pull、reminder-read / replay GET（含 competitor）。
- `MS-008` 更早 dest：`nodeHttpFetch` abort 竞态；competitor checkout hang 被审为 later-src abort-on-close。
- `MS-016`、`MS-017`、`MS-018`：dest 级 dual-fail。
- `MS-010`：仅 competitor fault-matrix socket hang up。
- `MS-004` 在 go-like 与 Kratos 上，对“新 idempotency key + UNIQUE rol-1001”都返回过 502，后改为复用 healthy key。
