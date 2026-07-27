# LikeGo 0.0.1 收敛修复实施计划

> 执行约束：直接使用当前 `main` 工作区；保护既有改动；不创建 worktree，不 commit，不 push。

## Task 1：Core 停机顺序

文件：

- `packages/core/test/app.test.ts`
- `packages/core/src/app.ts`
- `packages/core/README.md`
- `e2e/scripts/registry-transport-consul-docker.ts`

步骤：

1. 新增测试证明 deregister 时 Server.start Context 仍未取消，并覆盖父 Context 取消。
2. 运行 `bun test --isolate --no-orphans packages/core/test/app.test.ts`，确认测试按旧顺序失败。
3. 给 Server 使用独立运行 Context，在 deregister 后取消；不改变公开 API。
4. 增强 Consul + Transport Docker 脚本，在 deregister 阶段真实访问已注册端点。
5. 跑 Core 测试、typecheck 与该 Docker suite。

## Task 2：Client watcher 关闭失败

文件：

- `packages/client/test/client.test.ts`
- `packages/client/src/resolver.ts`

步骤：

1. 新增 `next()` 与 `stop()` 同时失败、并发 close 的测试。
2. 确认旧实现覆盖主错误或重试而失败。
3. 最小增加 terminal failure 状态，聚合错误并阻止重试。
4. 跑 Client 全包测试、coverage 与 typecheck。

## Task 3：Server.options 防御性快照与 Health 注销释放

文件：

- `packages/server/test/server.test.ts`
- `packages/server/src/index.ts`
- `packages/health/test/registry.test.ts`
- `packages/health/src/registry.ts`

步骤：

1. 新增修改一次 `options()` 返回 Map 后仍可正常 dispatch 的测试。
2. 确认旧实现失败。
3. 让 `options()` 返回现有 `snapshotOptions()` 的新快照。
4. 新增 WeakRef + GC 回归，证明注销后的 Health registration 不再被闭包保留。
5. 注销时立即从 registration 列表和 active name 集合移除记录，同时保持 unregister 幂等。
6. 跑 Server、Health 测试、coverage 与 typecheck。

## Task 4：运行时与依赖版本

文件：

- `config/runtime-matrix.json`
- `tools/runtime/**`
- 受影响的 `capability.json`、contract、fixture、README
- `packages/h3/**`、`examples/h3/**`
- Redis、etcd、OTel 的 Docker runner、contracts 与当前文档
- `.github/workflows/verify.yml`

步骤：

1. 先运行 runtime gate，保留 Deno `2.9.3` 期望与真实 `2.9.4` 的失败证据。
2. 同步 Deno `2.9.4` 与 H3 rc.26；更新 lockfile并跑定向 contracts。
3. 同步 Redis `8.8.1`、etcd `3.7.1`、OTel `0.157.0` 官方 digest。
4. 真实拉取并运行各 provider Docker tests；成功后新增本次 evidence report，历史报告不改写。
5. CI 显式设置矩阵运行时，跑 workflow contract。

## Task 5：首发 Changesets 与文档

文件：

- `.changeset/*.md`
- `README.md`
- `.changeset/README.md`
- `docs/capability-comparison.md`
- 相关 package/example README

步骤：

1. 核对 46 个公开包与现有首发 changesets 的覆盖关系。
2. 先以一次性 readback 核对首发基线是 46 个 `0.0.1`；补 release-config 红灯，长期约束 45 个首发记录已
   归档且不会与未来 active pending 重叠、首发说明覆盖全部公开包；fixture 真实锁定 patch/minor、历史归档不参与
   计算及 active changeset 消费行为，避免把后续合法版本永久锁死在 0.0.1。
3. 将 45 个原始 Changeset 逐字移动到 `docs/releases/0.0.1/changesets/`，生成 `docs/releases/0.0.1.md`；
   不执行版本命令，也不为首发前修复新增 active Changeset。
4. 修正文档中的首发例外、provider filter 数量、Examples 入口、版本与发布说明。
5. 跑 release-config、repository、doc-site 与 file-inventory tests。

## Task 6：全量验证与复审

1. 跑所有受影响包测试、typecheck、build。
2. 跑真实 Docker suites，核对容器、网络、volume 无残留。
3. 跑 `bun run verify` 与 `git diff --check`。
4. 由独立 reviewer 复查范围、上游对齐、错误语义和测试缺口；只修复有证据的问题。
