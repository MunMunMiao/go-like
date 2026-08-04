# go-like 0.0.1 收敛修复设计

日期：2026-07-25

状态：已批准（基于 2026-07-25 全仓审计结论）

## 目标

在不扩大 go-like v1 能力边界的前提下，修复已由代码或真实运行复现的问题，补齐回归测试，并把运行时、Docker 依赖、CI、首发 Changesets 与文档收敛到可验证状态。

明确不加入：gRPC/proto/IDL、Event Store/历史查询/replay、更多 Registry provider、`@go-like/struct`、统一 logger facade、自动发布流水线。

## 设计

### 1. Core 停机顺序

`App.stop()` 仍在开始阶段取消应用启动 Context，用于中断 endpoint、hook、register 等未完成启动步骤；`Server.start()` 改用保留 AppInfo 值、但由 App 独立取消的运行 Context。停机顺序固定为：

1. 取消启动 Context并等待启动收束；
2. 执行 `beforeStop`；
3. 注销 Registry 实例；
4. 取消 Server 运行 Context；
5. 并发调用 `Server.stop()`；
6. 执行 `afterStop`。

这样既不会因等待启动而死锁，也不会让监听器在注销前提前退出；父 Context 取消也统一进入同一停机序列。

### 2. Client watcher 失败保真

Discovery watcher 的 `next()` 与 `stop()` 同时失败时，按 `next`、`stop` 顺序返回一个 `AggregateError`。`stop()` 失败是 terminal failure：不清空 watcher、不重试、不吞错；并发 `Client.close()` 共享同一 Promise，且同一失败只报告一次。

### 3. Server 配置快照

`Server.options()` 每次返回新的防御性快照。调用方即使清空返回值内的 `Map`，也不能修改在线 dispatcher 的 handler 或 operation middleware。

### 4. Health

Health unregister 除了将记录标记为 inactive，还必须立即从 registration 列表和 active name 集合移除它，
避免返回的 unregister 闭包继续间接保留已注销 probe。保留现有 fail-closed、取消、超时与幂等行为，使用
WeakRef + 强制 GC 回归锁定释放语义。

### 5. 版本与 CI

- Deno 固定为 `2.9.4`，同步 live matrix、contracts 与 fixtures；历史报告和历史计划不改写。
- H3 使用最新正式版 `1.15.11`，执行 package、example 与 E2E 回归。
- Redis 升级到 `8.8.1-alpine`、etcd 升级到 `3.7.1`、OpenTelemetry Collector Contrib 升级到 `0.157.0`，使用官方 multi-arch digest 并跑真实 Docker。
- RabbitMQ 保留已验证的 `4.3.4` 固定 digest；同 tag 的 digest 漂移不是版本升级。
- CI 显式安装仓库矩阵要求的 Node 与 Deno，不再依赖 runner 偶然自带版本。

### 6. 首发与文档

现有 45 个 Changeset 记录的都是 `0.0.1` 首发前工作。真实运行 Changesets 2.31.1 已证明，直接执行
`version` 会把 46 个包拆成 `0.1.0`、`0.0.2` 和 `0.0.1` 三组；直接 `publish` 又不会消费这些 pending
记录。因此把原文件逐字归档到 `docs/releases/0.0.1/changesets/`，生成覆盖全部 46 个包的首发说明，并清空
active pending 队列。首发前不运行 `version:packages`；首发后的变更再恢复标准 Changesets 流程。

同步 provider 数量、Examples 入口、运行时版本与发布操作说明。

## 验证

每个行为修复先写会失败的测试，再写最小实现。服务依赖使用真实 Docker；最后执行定向测试、包级 typecheck、`bun run verify`、`git diff --check` 与 Docker 残留检查。本轮不提交、不推送。
