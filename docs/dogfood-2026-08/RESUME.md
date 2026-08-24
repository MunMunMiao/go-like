# 以后如何把 40 个项目跑完

本文给未来的自己：库侧 P0 已经落地并推过对照回归。剩下的是 **还没开的 15 个样本**，以及 dual-fail 五项若要再隔离，必须开 **新 dest**，不要改写旧证据。

原始 run 日志仍在 `go-like-dogfood`。本目录是生产者可读的进度，不是可再跑的 dest。

## 现在库在哪

| 项 | 值 |
| --- | --- |
| 仓库 | `/Users/munmunmiao/Documents/web/likego`，远程 `origin` = `git@github.com:MunMunMiao/go-like.git` |
| 分支 | `main` |
| 对照回归时的生产者 | `43abe749cb9e05c56c99b07a3595dbdb8c2121a0` |
| 已合入的库改动 | REST `httpRoute`、httpRoute 上 `ServiceError` 的 HTTP 载体状态、recovering RabbitMQ 先 admit、`newServer` 默认 `GET`/`HEAD` `/healthz` |

下一轮 dest 的 `campaign.json` `producer.sha` 应对齐当时的 `git rev-parse HEAD`，不要默默退回 `cd15313d`。

## 40 个项目进度（人话）

| 状态 | 项目 | 说明 |
| --- | --- | --- |
| 未启动，以后要跑 | `MS-019` `MS-021` `MS-023` `MS-024` `MS-026` `MS-028` `MS-029` `MS-030` `MS-031` `MS-032` `MS-034` `MS-035` `MS-036` `MS-038` `MS-040` | 无 dest。这是「跑完 40 个」的主清单。 |
| 已对照通过（0 条产品缺陷） | 见 [inventory.json](inventory.json) 里 `assertionsPassed=true` 的 12 项 | 不必重开，除非库又改了相关面。 |
| P0 已修并重新对照通过 | `MS-020` dest `fw-r252`；`MS-009` dest `fw-r253`；`MS-006` dest `fw-r254` | 旧失败 dest（`fw-r183` / `fw-r230` / `fw-r214`）保留，不要改写。 |
| 双侧都失败，禁止当库缺陷 | `MS-011` `MS-013` `MS-016` `MS-017` `MS-018` | 要再打，必须新 dest 做出「只有 go-like 失败、对照通过」。 |
| 仅对照失败 | `MS-010` | 不进 `@go-like/*` 队列。 |
| first-wave，无 verify | `MS-022` `MS-033` `MS-037` `MS-039` | 无 findings。不要当库结论。 |

详细判定见 [dest-learn-report.md](dest-learn-report.md) 与 [next-work.md](next-work.md)。

## 开新 dest 时记住

1. **新编号**：现有关闭 dest 用到 `fw-r254`。下一轮从 **`fw-r255` 或更大** 开，不要占用已烧过的 dest。
2. **一次一条 Compose**；Docker 用 `unix:///Users/munmunmiao/.docker/run/docker.sock`。
3. **不要 `init`**。复制已冻结的 `campaign.json`（或按当时 HEAD 重新 stage-producer），再 `register-project`。
4. 消费者用 `git clone --no-local --no-hardlinks`，vendor tarball `nlink=1`。
5. 探活等 **HTTP/TLS 响应**，不要只等 Docker 发布端口的 TCP。
6. go-like 失败且对照通过，才许改 `packages/`。两边同一阶段都挂，记 dest/harness，不改库。
7. 禁止：先绑 HTTP 再 recovering setup；go-like 车道用原生 `http2` 监听器冒充公共传输；给 dest/harness 编造库缺陷。
8. 证据 CLI 仍是 `/Users/munmunmiao/Documents/web/go-like-dogfood/dist/src/cli.js`。dogfood 仓库本地可能有未提交的 CLI 放行 SHA，不要默默推进 likego。

## 建议开工顺序

1. 15 个未启动 ID，按战役花名册的开发者与 start-order，一次一个项目、一个 dest。
2. 每个项目四条车道各三次（local/docker × go-like/competitor）。第一次失败不要在同一 dest 上重跑同一 repetition 来「凑满」——会烧掉槽位。
3. 只有新的「go-like 失败、对照通过」才开库票，修完再开 **另一个** 新 dest 回归。
4. dual-fail 五项排在未启动清单之后；没有对照通过就不要改库。

读完本文后的阅读顺序：[dest-learn-report.md](dest-learn-report.md) → [findings-catalog.md](findings-catalog.md) → [ux-summary.md](ux-summary.md)。
