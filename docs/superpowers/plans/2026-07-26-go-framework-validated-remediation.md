# go-like Go 框架实证对齐与修复计划

日期：2026-07-26
状态：已实施并验收
执行范围：当前 `main` 工作区；不创建 worktree，不提交，不推送，不发布。

## 1. 目标与结论

本计划针对当前审计发现的具体问题，对照最新版 Go、go-micro、go-kratos 和
go-zlab/go-kratos 的真实源码与运行行为，区分以下三类情况：

1. go-like 有意采用了更适合 TypeScript、Promise、标准 Web API 或结构式 Server 的设计；
2. 设计本身合理，但某条实现路径没有贯彻既有契约；
3. 与 Go 框架无直接产品语义关系的本地测试、Docker、构建或文档缺陷。

本轮确认需要修复 9 组问题，其中高优先级 2 组、中优先级 2 组、低优先级 5 组。没有发现需要推翻
go-like 当前分层、Server 接口、Context 公共 API、Registry provider 范围或 examples 目录模型的证据。

核心判断如下：

- 内部 HTTP Transport 不应让 3xx 绕过 Discovery/Selector 重新选择目的端；portable Fetch 当前默认跟随
  307 是实现缺陷。
- `@go-like/context` 让自定义 `StopFunc` 异常向外传播，与 Go 一致；Core waiter 保留已胜出的 Promise
  结果是有意增强，Client 私有旧副本才是缺陷。
- Croner one-shot/factory ownership 是合理增强；factory 内重入 `stop()` 后任务仍被恢复运行，违反 go-like
  自身 Server 契约。
- Client/Server operation middleware 的 exact、最长前缀和 `*` fallback 设计正确；只缺少与 canonical
  `service/endpoint` 一致的构造期校验。
- Consul/etcd 的 per-identity FIFO 和 replacement rollback 应保留；空 identity state 永久留在 Map 中没有
  产品价值，应安全回收。
- go-like 在 examples 数量、跨 runtime 与显式 Docker cleanup 证据上覆盖更细；这不等于整体成熟度强于
  多年运行的上游。本轮只修真实的 false-green、漏跑和 owner 协议缺口，不再增加一套全 examples
  source-inventory 框架。

## 2. 调研基线

| 项目 | 最新基线 | 本轮用途 |
| --- | --- | --- |
| Go | [`go1.26.5`](https://go.dev/doc/devel/release)，提交 [`c19862e5f8415b4f24b189d065ed739517c548ba`](https://github.com/golang/go/commit/c19862e5f8415b4f24b189d065ed739517c548ba) | `context.AfterFunc`、`net/http.Client` 与 `httptest` 实验 |
| go-micro | 最新正式版 [`v6.8.0`](https://github.com/micro/go-micro/releases/tag/v6.8.0)，提交 [`db4401d306039be2614e0e3657c6a5c6473feb3b`](https://github.com/micro/go-micro/commit/db4401d306039be2614e0e3657c6a5c6473feb3b) | HTTP Transport、Service lifecycle、Registry 清理和 examples |
| go-micro 默认分支 | [`9d306dcfc1a912a8a9493f31fee0bb983475258d`](https://github.com/micro/go-micro/commit/9d306dcfc1a912a8a9493f31fee0bb983475258d) | 复核相关实现自最新正式版后没有语义变化 |
| go-kratos | 最新正式版 `v3.0.0`，同时为 `main` HEAD：[`668db92c2c001e9552594ba5a8aede8456af6d7e`](https://github.com/go-kratos/kratos/commit/668db92c2c001e9552594ba5a8aede8456af6d7e) | App/Server lifecycle、HTTP Client、middleware matcher、Registry 清理 |
| go-zlab/go-kratos | 根 release `v1.0.0`、`transport/cron/v1.0.0`：[`2a47dd8baf53b79023005781d456ef8e1e4abfb1`](https://github.com/go-zlab/go-kratos/commit/2a47dd8baf53b79023005781d456ef8e1e4abfb1) | Cron Server 实现与第三方 Server 适配方式 |
| go-zlab 默认分支 | [`ecd00dd24491d09642c76542f94e392c6d639336`](https://github.com/go-zlab/go-kratos/commit/ecd00dd24491d09642c76542f94e392c6d639336) | 确认 Cron 相关文件与正式 module tag 相同 |
| go-like | 当前工作区，Git 基线 `078e24c3b6ebc9228968acf3489cddc7e552b0c4` 加未提交实现 | 比较当前真实代码，不把未发布状态描述成 release |

Kratos 官方 examples 已迁移到独立仓库；其当前 HEAD 为
[`61daed1ec4d5a94d689bc8fab9bc960c6af73ead`](https://github.com/go-kratos/examples/commit/61daed1ec4d5a94d689bc8fab9bc960c6af73ead)，
但仍主要依赖 Kratos v2，因此仅用于观察示例组织，不作为 Kratos v3 行为依据。

## 3. 调查与实验方法

调查分为 Transport/Client、Context/Core/Croner、Registry/examples/Docker 三条并行证据线，并由独立反方
审查逐项寻找错误类比、不可实施步骤和 false-green 验收；最终结论由主线按本地调用链重新合并复核。

1. 将上述精确提交 shallow checkout 到 `/tmp`，逐段核对实现和测试，而不是只阅读 README。
2. 使用本机 Go `1.26.5`、Bun `1.3.14`、Node.js、Deno 和真实 Croner `10.0.1` 编写最小复现。
3. HTTP redirect 使用两个真实本地监听端点；Registry 行为使用真实 etcd `3.7.1` Docker。
4. 对上游运行定向 Go tests；遇到上游自身的环境或交互式测试限制时单独记录，不把失败伪装成通过。
5. 对 go-like 先运行现有测试，再运行当前测试未覆盖的独立复现，用于证明门禁盲区。

关键实验结果：

- Go 默认 HTTP Client 对 307 保留 POST body、自定义 header 和同 hostname 不同 port 的 Authorization；第二
  端点收到请求。go-micro raw `net.Conn` Transport 返回 307 error，第二端点零请求；Kratos 继承
  `http.Client` 默认行为，第二端点收到请求。
- go-like 高层 Client 经过真实 `newClient`、HTTP Transport 和双端点 307 后，第二端点收到 POST body、
  自定义 metadata、`Go-Like-Service` 与 `Go-Like-Endpoint`，并把第二端点的 200 当成成功。
- Go 自定义 `context.AfterFunc` stopper 抛出时会 panic；go-like Client 当前复现结果为 waiter 超时且出现
  `unhandled: stop boom`。
- Croner factory 内同步调用同一 Server 的 `stop()` 后，当前结果为 `start` 已 resolve，但 native Cron 仍
  `running=true`、`stopped=false`。
- go-micro Consul/etcd 定向测试通过；真实 etcd Docker 上 go-micro keepalive 与 Kratos Registry 测试通过，
  两轮实验清理后容器残留为零。
- `enterprise-platform-runtime` coverage 命令退出 0，但真实结果只有 85.42% functions、97.83% lines；
  当前 `line`/`function` 配置没有执行预期的 100% 阈值。
- 本轮调查前的完整 `bun run verify` 基线退出 0，耗时 925.69 秒；它覆盖 44 个 examples、81 个 E2E
  用例、28 个 suite 和 15 个 Docker suite，但仍未覆盖本计划列出的缺口。

上游验证边界：

- go-micro `transport`、`registry/consul`、`registry/etcd` 定向测试通过。
- Kratos `internal/matcher`、`middleware/selector` 与 HTTP Client 定向测试通过；完整
  `transport/http` suite 在本机选择 `10.0.0.215` 后由 `TestServer` 稳定得到 EOF，因此不将该 suite 写成通过，
  也不使用这个无关失败支撑本计划结论。
- go-zlab Cron 的 `TestServer` 会等待真实 OS signal；`TestTransport_Kind` 又因用 `reflect.DeepEqual`
  比较 `string` 与 Kratos `transport.Kind` 而报告 `expect cron, got cron`。只有
  `go test -run '^$' ./...` 的 compile-only 检查通过。本轮使用独立最小程序验证其 Start/Stop 行为，
  不把现有交互测试或类型断言失败当成 go-like 的质量 oracle。

## 4. 逐项判定矩阵

| 优先级 | 问题 | Go / 上游事实 | go-like 设计判定 | 处理 |
| --- | --- | --- | --- | --- |
| P1 | portable Fetch 跟随 307 | go-micro 不跟随；Kratos 继承 Go 默认跟随 | 内部节点已由 Selector 决定，portable 与 Node native 语义不一致 | 修复为 `redirect: "manual"` |
| P1 | Client waiter 遇 throwing `StopFunc` 悬挂 | Go custom stopper 可 panic；上游没有 Promise waiter | Context 正确；Core 增强正确；Client 私有副本无意偏离 | 删除副本并复用 Core |
| P3 | Croner factory 内 stop 后任务复活 | 上游不承诺 factory 自同步重入安全 | go-like one-shot 设计正确；这是防御性实现缺口 | 封闭 factory 自重入路径 |
| P2 | operation selector 接受永不匹配值 | Kratos matcher 宽松并 silent miss；go-micro 无同层 matcher | go-like canonical operation 与对称 Client/Server `use` 是有意设计 | 只补构造期校验 |
| P3 | Consul/etcd identity Map 不回收 | go-micro、Kratos 注销时清理本地状态 | FIFO/rollback 正确；永久空状态不是有意缓存 | 引用计数后安全删除 |
| P2 | example coverage false-green、默认可运行案例漏跑 | 上游没有 go-like 同等级门禁 | 严格门禁是有意设计；配置和筛选实现有缺口 | 修阈值和外部服务声明 |
| P3 | 三个 provider Docker harness 忽略 owner | 上游多依赖 job-scoped service，无同类协议 | go-like owner 协议是有意增强，但执行不完整 | 接入现有 owner label |
| P3 | 完整 verify 重复 build 三次 | Go build cache 可复用，不能直接类比 tsdown | 独立命令自包含正确；组合命令重复无价值 | 只优化组合 `verify` |
| P3 | locale 文档漏 Store Memory；`tsc-alias` 未使用 | 与 Go 产品语义无直接关系 | 本地文档遗漏和死依赖 | 补文档、删依赖 |

## 5. 修复顺序

### Task 1：锁住内部 HTTP redirect 信任边界

文件：

- `packages/transport/http/src/client.ts`
- `packages/transport/http/test/client.test.ts`
- `packages/transport/http/test/runtime/portable-runtime.ts`
- `packages/transport/http/README.md`

实施：

1. 在 portable Fetch 构造的标准 `RequestInit` 中固定 `redirect: "manual"`。
2. 不增加“允许 redirect”公共选项；首版内部 Transport 没有第二套路由协议。
3. 新增同 origin 与跨 origin 两组真实双端点 307 回归，发送 body、自定义 header、go-like
   service/endpoint/metadata；两组均断言 redirect destination 请求数为零，跨 origin 用例额外锁定内部 metadata
   不会泄漏到其他 origin。
4. 断言 307 继续经过现有 `receiveMessage` 产生相同的 HTTP status error，不创建新错误类型。
5. 保留 Node native executor 的固定 dial origin 行为，并在 Bun、Node、Deno portable runtime lane 中验证
   `Request.redirect === "manual"`。
6. 在 README 明确内部 Transport 不自动跟随 redirect；自定义 Fetch executor 也必须遵守传入
   `Request.redirect`，不能私自重放请求。

验收：

```sh
bun run --filter @go-like/transport-http test:coverage
bun run --filter @go-like/transport-http smoke:bun
bun run --filter @go-like/transport-http smoke:node
bun run --filter @go-like/transport-http smoke:deno
bun run --filter @go-like/transport-http e2e:node
```

### Task 2：统一 Client 的 Context waiter

文件：

- `packages/client/src/resolver.ts`
- `packages/client/src/index.ts`
- `packages/client/package.json`
- `bun.lock`
- `packages/client/test/client.test.ts`
- `packages/client/test/package-contract.test.ts`
- `test/repository-contract.test.ts`

实施：

1. 删除 `resolver.ts` 的私有 `waitForContext`。
2. `resolver.ts` 与 `index.ts` 复用现有 `@go-like/core/lifecycle` 导出。
3. 在 Client runtime dependencies 中加入精确版本 `"@go-like/core": "0.0.1"`；发布 tarball 不能依赖
   workspace 偶然解析。
4. 从根目录执行 `bun add --cwd packages/client --exact @go-like/core@0.0.1` 同步 manifest 与 `bun.lock`，并
   核对 lockfile 的 Client workspace dependency record；不手改 lockfile。
5. 同步 Client package contract 与 repository dependency contract；两处都要锁定这条精确直接依赖。
6. 新增 operation fulfilled、operation rejected 两种 throwing `StopFunc` 回归，断言原 operation 结果胜出、
   waiter 必定结算且没有 unhandled rejection。
7. 不修改 `@go-like/context.afterFunc`，也不新建 util package。

依赖图不会成环：`client → core → registry → metadata → context`；Core、Registry、Metadata、Context 均不
反向依赖 Client，现有 Client TypeScript references 也已包含 Core。

验收：

```sh
bun run --filter @go-like/client test:coverage
bun run --filter @go-like/client typecheck
bun run --filter @go-like/client build
bun test packages/client/test/package-contract.test.ts test/repository-contract.test.ts
```

### Task 3：封闭 Croner factory 自同步重入

文件：

- `packages/croner/src/server.ts`
- `packages/croner/test/lifecycle.test.ts`
- `packages/croner/test/construction.test.ts`

实施：

CronerFactory 是同步函数。正常异步并发无法在 factory 调用栈内插入 stop；当前复现只来自 factory 主动调用
同一个 Server 的 `stop()`。因此只封闭这个真实路径，不泛化出新的公共 lifecycle framework：

1. `starting` 收到 self-reentrant stop 时记录 stopping，并先发布稳定、尚未结算的 `ownerStop`；不能对空
   jobs 提前结算 runtime。
2. factory 返回后立即收集 provisional jobs 并检查状态；若已经 stopping，禁止 `resume()` 和写入
   `running`。
3. 由该 start admission 的唯一 owner 逆序停止 provisional jobs、取消 runtime Context，再统一结算 start 与
   stop waiter。
4. 在调用任意 native `stop()` 前先发布 owner Promise，避免同步 stop failure 再次重入。
5. startup 与 cleanup 同时失败时保留稳定 Error identity 或既有顺序的 `AggregateError`。

允许的状态迁移：

```text
idle -> starting -> running -> stopping -> stopped | failed
idle -> stopped
starting -> stopping -> stopped | failed
starting -> failed
```

禁止 `stopping` 或 `stopped` 再写回 `running`。

新增回归：

- factory 内 clean stop：start/stop 都结算，Cron `isStopped()` 为 true、`isRunning()` 为 false；
- 同路径 native stop 抛错：start/stop 观察同一 terminal failure，不遗留运行任务。

验收：

```sh
bun test --isolate --no-orphans \
  packages/croner/test/lifecycle.test.ts \
  packages/croner/test/construction.test.ts
bun run --filter @go-like/croner typecheck
bun run --filter @go-like/croner test:coverage
bun run test:e2e:prepared -- --suite cron-native
```

Croner 是真实进程内调度器，不需要为了形式套 Docker；上述 E2E 必须使用真实 Croner。

### Task 4：补齐 canonical operation selector 校验

文件：

- `packages/client/src/index.ts`
- `packages/client/test/client.test.ts`
- `packages/client/README.md`
- `packages/server/src/index.ts`
- `packages/server/test/server.test.ts`
- `packages/server/README.md`

实施：

1. 保留 exact、最长 trailing-prefix 与 `*` fallback，不加入 Regex、Path 或 custom matcher。
2. exact 只接受 canonical `token/token`；token 为非空 visible ASCII，且不含 `/`、`*`。
3. wildcard 接受 `*`、`token*`、`token/token*`；`orders/*` 与 `orders/Get*` 均合法。
4. 拒绝空值、`orders`、`orders/`、`/Get`、`orders//Get`、前导空格、Unicode、内部或多个 `*`。
5. 同时覆盖直接 `use()` 和 custom Options Map 的重新校验，防止 option seam 绕过验证。
6. Client、Server 各自保留最小私有 validator；不新增公共 matcher 包。
7. 两份 README 同步说明 exact、trailing wildcard、`*` fallback 及构造期 fail-fast，避免公共行为只存在于
   测试中。

验收：

```sh
bun run --filter @go-like/client test:coverage
bun run --filter @go-like/server test:coverage
bun run --filter @go-like/client typecheck
bun run --filter @go-like/server typecheck
```

### Task 5：回收 Consul/etcd 空 identity state

文件：

- `packages/registry/consul/src/registration.ts`
- `packages/registry/consul/test/registration.test.ts`
- `packages/registry/etcd/src/registration.ts`
- `packages/registry/etcd/test/registration-boundaries.test.ts`

实施：

1. 为两个 provider 的私有 `IdentityState` 增加当前 owner/waiter 引用数。
2. `acquire` 在等待前增加引用，幂等 release 后递减。
3. 仅当 `active === null`、引用数为零且 Map 中仍是同一个 state 时删除，避免 ABA。
4. 不在单次 deregister 后直接删除；同 identity 已排队的 register/deregister 必须继续共享一个 FIFO tail。
5. Consul 与 etcd 使用相同的局部模式，但不抽跨 provider 公共包。
6. 在各自 `registration.ts` 内提供只供相对路径测试使用的 identity-count 观测点；不得从 package
   `index.ts` 导出，也不得成为公共 API。没有这个观测点，旧实现也可能通过全部远端行为测试。

新增回归：

- 大量 distinct identity 的失败 register；
- 大量未知 identity 的幂等 deregister；
- 成功 register/deregister churn；
- 同 identity 并发 replacement/deregister，证明 FIFO、rollback 与 generation ownership 未被破坏。

每类回归同时断言：active registration 时 count 为 1，失败、未知 deregister 或完整 churn 收敛后 count 回到
0。

验收必须包含真实服务：

```sh
bun run --filter @go-like/registry-consul test:coverage
bun run --filter @go-like/registry-etcd test:coverage
bun run --filter @go-like/registry-consul typecheck
bun run --filter @go-like/registry-etcd typecheck
bun run test:e2e:prepared -- --suite registry-consul-docker
bun run test:e2e:prepared -- --suite registry-etcd-docker
```

### Task 6：修复 examples 的 false-green 与漏跑

文件：

- `examples/enterprise-platform-runtime/bunfig.toml`
- `examples/enterprise-platform-runtime/test/unit/*.test.ts`
- `examples/catalog.json`
- `scripts/verify-example-programs.cli.ts`
- `examples/README.md`
- `test/repository-contract.test.ts`

实施：

1. 将 enterprise coverage 阈值改为仓库已验证生效的 `lines`、`functions` 配置。
2. 补齐 `echo.ts` 与 `management.ts` 当前未覆盖分支，使 unit lane 真实达到 100%；不通过导入
   `main.ts` 人为启动进程。
3. 在 catalog 增加可选 `requiresExternalServices?: true`；默认 false。只给默认启动确实依赖外部服务的
   commerce、SaaS、payments、IoT、batch 和 enterprise 六个案例标记 true。
4. direct-run lane 选择 `requiresExternalServices !== true`。`cybersecurity-alert-triage` 的默认内存模式因此
   会被运行，其可选 etcd 路径仍由 Docker lane 验证；Tier 继续只表达验证深度。
5. 扩展 repository catalog contract：该可选字段只允许缺省或字面量 true，并锁定当前六个默认外部依赖案例
   与默认可直接运行的 cybersecurity 案例。
6. 保留根探针接受 `<500`：该门禁验证监听、ready、SIGTERM 与端口释放，不强迫所有程序提供 `/` 业务路由。
7. 不新增“所有 example production source 必须进入 lcov”的中央框架。发布包已有独立 source inventory；
   example 的进程装配继续由 direct-run、Node 和 Docker E2E 验证。

验收：

```sh
bun run --filter @go-like/example-enterprise-platform-runtime test:coverage
bun test test/repository-contract.test.ts
bun run test:examples
bun run test:examples:programs
bun run test:examples:docker
```

输出必须证明 `cybersecurity-alert-triage` 被 direct-run lane 启动、探测并停止。

### Task 7：为独立 provider Docker gate 增加真实外层 owner supervisor

文件：

- `packages/broker/rabbitmq/test/e2e/rabbitmq-docker-e2e.ts`
- `packages/cache/redis/test/integration/redis-docker.ts`
- `packages/config/vault/test/integration/vault-docker.ts`
- `packages/store/vault/test/integration/vault-docker.ts`
- `scripts/provider-docker-gate.cli.ts`
- `package.json`
- `scripts/verify-workspace.ts`
- `scripts/verify-workspace.test.ts`
- `e2e/suites.ts`
- `e2e/suites.test.ts`
- `docs/file-inventory.md`

实施：

仅给资源添加 label 不能在 harness 被杀死后执行清理，不能把 label 本身写成 cleanup 证明。完整最小修复为：

1. 三个 harness 复用现有 owner 格式校验，fail closed 读取 `GO_LIKE_E2E_OWNER`；Docker resource 同时保留
   随机 run label，并增加 `io.go-like.e2e.owner=<owner>`。
2. 给现有 `runCommand` 的私有 CommandDefinition 增加可选 AbortSignal；pre-aborted signal 必须在
   `Bun.spawn` 前原样拒绝。timeout 或运行中 abort 胜出时复用已有 process-tree termination，abort 必须原样
   抛出 signal reason；正常退出和 abort 后都移除 listener。分别补 timeout、pre-abort、运行中 abort 与
   listener cleanup 回归。
3. 将当前 workspace filter 命令保留为 `test:providers:docker:prepared`；新增根 provider-gate CLI，每次生成
   唯一 owner，以 detached 子进程运行该 prepared 命令，并复用 `e2e/suites.ts` 的 `runCommand` 与
   `verifyDockerOwnerCleanup`。不能继续使用固定 `provider-gate` owner，也不能让 wrapper 递归调用自己。
4. 子进程失败、超时或 supervisor 收到 SIGINT/SIGTERM 时，通过 AbortSignal 终止子进程组，再按 owner 清理
   container、network 和 volume，最后保留原始退出原因。
5. supervisor 使用代码内固定的 20 分钟总 hard timeout，并为 cleanup 保留最后 60 秒；prepared child 只能
   使用前 19 分钟。该门禁固定覆盖 RabbitMQ、Redis、K3s 与两条 Vault harness，并由测试锁定，不增加可配置
   provider framework。
6. 根 `test:providers:docker` 改为调用 supervisor；独立 package `test:docker` 仍保留自己的正常 finally
   cleanup。
7. 将三个 harness 加入现有静态 owner contract，并用真实 Docker 资源执行 child kill/cancel 回归，证明
   current owner 被清理而 foreign owner 保留。
8. 中央 container cleanup、RabbitMQ 和 Config Vault 的正常 cleanup 必须使用 `docker rm --force --volumes`；
   真实回归需读取并验证镜像创建的匿名 volume 已删除，不能只盘点带 owner label 的 volume。Store Vault
   已使用 `--volumes`，Redis 8.8.1 镜像没有声明 volume，二者不增加额外分支。
9. 不创建 Docker helper package。必须明确：如果 supervisor 进程本身收到不可捕获的 SIGKILL，任何进程内
   finally 都不可能自动运行；本任务只承诺由仍存活的外层 supervisor 收敛 child crash/cancel。
10. 新增 CLI 后运行 `bun scripts/generate-file-inventory.cli.ts` 生成受控 inventory，不手写该文档。

验收必须通过新 supervisor 真实启动 RabbitMQ、Redis、K3s 与 Vault：

```sh
bun run test:providers:docker
bun run test:e2e:docker-ownership
bun run verify:file-inventory
```

验证 current owner 零残留，foreign owner 资源不被删除。
匿名 volume 也必须按真实 volume name 回读为不存在，不能用 owner-label inventory 代替。

### Task 8：只消除完整 verify 内的重复 build

文件：

- `package.json`
- `scripts/verify-workspace.ts`
- `scripts/verify-workspace.test.ts`

实施：

1. 保留 `test:examples:programs` 与 `test:examples:node` 独立执行时先 build 的自包含 UX。
2. 完整 `verify` 在 `typecheck` 已完成 `build:packages` 后，直接运行 prepared 内层命令：

```sh
bun scripts/verify-example-programs.cli.ts
bun run --filter '@go-like/example-*' --parallel --if-present e2e:node:prepared
```

3. 同步根脚本契约测试；不引入 task runner、构建缓存层或新依赖。

验收：

```sh
bun test scripts/verify-workspace.test.ts
bun run verify:workspace
bun run verify
```

完整 verify 的 package build 应从三次降为一次，独立两个 example 命令仍可单独运行。

### Task 9：补齐 Store Memory 文档并删除死依赖

文件：

- 八份 `doc/**/reference/packages.md`
- `test/doc-site.test.ts`
- `package.json`
- `bun.lock`
- `scripts/verify-workspace.ts`
- `scripts/verify-workspace.test.ts`

实施：

1. 在默认、简体中文、繁体中文（香港）、繁体中文（台湾）、阿拉伯语、西班牙语、法语和俄语 package
   reference 中补充 `@go-like/store-memory`；以实际文件清单为准，共八份。
2. 在现有 doc-site test 循环断言每份 package reference 包含该精确包名。
3. 使用 Bun 删除根直接开发依赖：`bun remove tsc-alias`。
4. 更新 lockfile 和 workspace 固定依赖期望；不寻找替代依赖，当前 tsdown 已完成构建产物处理。

验收：

```sh
bun test test/doc-site.test.ts scripts/verify-workspace.test.ts
bun run verify:workspace
bun run verify:doc
```

负向 readback 单独执行 `bun pm why tsc-alias`：Bun 1.3.14 应输出
`No packages matching tsc-alias found in lockfile` 并以预期的 exit 1 退出；不得把这个 exit 1 写成门禁失败。

## 6. 明确保留或不实施的事项

以下不是待修功能：

1. 不复制 Kratos 默认 redirect 行为；它继承的是通用 `net/http.Client` 默认值，会绕过内部 Selector 的首次
   节点决策。
2. 不改变 `@go-like/context` 的 throwing custom `StopFunc` 行为；异常隔离只发生在 Promise waiter 边界。
3. 不把 Client operation `use()` 删除为 go-micro 的全局 wrapper，也不补 Kratos Regex/Path/Match；当前对称
   Client/Server API 是有意设计。
4. 不把 go-zlab Cron 的构造期 scheduler 和 `Name()` 搬入 go-like；Croner 只适配 native lifecycle，仍是普通
   结构式 Server。
5. 不新增 Registry provider。当前 Registry 范围已经由产品决策冻结。
6. 不增加全 examples source-inventory 框架，不把 root 404 改成失败，也不把 examples 改回单文件片段。
7. 不新增 Docker cleanup abstraction、构建 task runner、redirect 配置项或公共 matcher 包。
8. 不重新引入 gRPC/proto、Event Store、历史查询或事件 replay。
9. 不修改 Changesets 首发归档策略；本轮没有发现该策略的新缺陷。
10. 远端 GitHub Actions 尚无首次运行证据是交付状态，不是本地代码修复项；在仓库真正推送后再回读
    workflow 与 branch protection。

## 7. 最终验收门禁

每个 Task 先运行定向红灯与修复后绿灯；完成全部任务后依次执行：

```sh
bun run fmt:check
bun run verify:workspace
bun run verify:manifests
bun run verify:file-inventory
bun run verify
git diff --check
```

涉及 Consul、etcd、Redis、Vault 的路径必须使用上述真实 Docker commands，不得以 mock 或签入报告替代。
最后按 owner label、container name、network 和 volume 回读 Docker，确认本轮资源零残留且没有清理其他 owner
资源。

完成标准：

- 9 组问题均有会在旧实现失败的最小回归；
- 所有 Promise waiter 均有明确 terminal outcome，无 unhandled rejection；
- 内部 HTTP 307 不触达第二 origin；
- Croner factory 自同步重入 stop 后不能从 stopping/stopped 回到 running；
- Registry identity churn 后本地 Map 可回收且同 identity FIFO 不破坏；
- examples coverage 阈值真实生效，所有默认无外部依赖的程序都进入 direct-run lane；
- 完整 verify 只执行一次 package build；
- Docker current owner 零残留；
- 全量 `bun run verify`、`git diff --check` 最终退出 0。

如果完整门禁未执行、仍在运行或任一命令失败，不得将修复状态标记为完成。
