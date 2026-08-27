# go-like 新代码复审与修复设计

日期：2026-07-26

状态：已批准执行（用户已授权在团队调查后直接采用最优方案）

范围：当前 `main` 工作区；不创建 worktree，不提交，不推送，不发布。

## 1. 目标

本轮不继续扩充 go-like 的能力面，而是检查新增实现是否存在运行时死锁、未处理 Promise、验证假绿、发布边界和公开文档失真。所有修改必须由当前代码或真实命令复现支撑，并维持既定产品边界：标准 Web API、结构式 Server、外部 Web 与内部 Transport 分离、无 gRPC/Proto、无 Event Store/replay、Registry provider 不再扩张。

## 2. 团队调查与主线复核

三条独立调查线分别覆盖核心语义、发布与运行门禁、Examples 与开发者体验。主线重新执行最小复现后确认：

1. `@go-like/core` 在 Server Promise 创建后、安装失败监听前存在窗口。Server 立即拒绝且 `afterStart` 延迟时，会产生一次 `unhandledRejection`。
2. `@go-like/web/node` 在 `start()` 后同一事件循环调用 `stop()` 时，stop 可结束，但 start Promise 永久 pending。
3. `bun audit` 报告 2 个 high、3 个 moderate 开发链漏洞；`bun audit --production` 通过。受影响链路为 Ajv 的 `fast-uri` 和 VitePress 的 Vite/esbuild，不进入 go-like 发布包运行时。
4. `@go-like/core`、`@go-like/web`、`@go-like/create` 尚未发布到 npm，而根 README 与站点仍把 registry 安装命令写成当前可执行路径。
5. 44 个 example 的业务测试与 38 个无需外部服务的程序启动检查均可通过，但根 `test:examples` 实际调用无统一阈值的 coverage 命令，名称与门禁含义不清晰。
6. release preflight 只检查 dirty tree 与 changeset；干净的错误分支、detached HEAD 或未与 `origin/main` 对齐的提交仍可进入发布命令。
7. 多语言 package reference 缺少 `@go-like/create`，部分 locale 还漏列已经发布规划内的 provider；example portfolio 有一处 tier 与 `catalog.json` 不一致。

## 3. 方案比较

### 方案 A：只修已证实根因，并收紧现有门禁（采用）

- Promise 在创建时立即受观察，仍保留原 Promise 供最终错误聚合。
- Node Web 的 startup admission 由 Runtime 暴露一个内部 clean-stop settlement；不新增公共状态机或 option。
- 用稳定且兼容的 transitive override 修复依赖，现有文档构建验证 VitePress 与 Vite 6 的实际兼容性，并把 `bun audit` 纳入 verify。
- Examples 的发布门禁明确为业务测试、直接启动和 Docker E2E；`test:examples` 执行 `test`，不伪装成全源码 100% coverage。
- release preflight fail-closed 地核对 `main`、upstream 和刷新后的 `origin/main`。
- 文档从发布包清单和 catalog 事实源校验关键枚举。

该方案修改面最小，所有行为都有可运行回归，不引入新的产品概念。

### 方案 B：为 44 个 Examples 建立全源码 100% coverage inventory（不采用）

该方案会要求测试 `main.ts` 等进程装配代码，或者给 44 个目录增加大量局部 coverage 配置与形式测试。Examples 的主要契约是可运行程序和真实服务组合，现有 direct-run、Node 与 Docker lane 更接近用户行为。只有当未来将 example coverage 明确设为发布质量指标时，才应单独设计 source inventory；本轮不为一个未定义的数字增加数百个低价值断言。

### 方案 C：只修文档与依赖，不改生命周期（不采用）

两个生命周期问题已经由最小程序稳定复现：一个可能在严格未处理拒绝策略下终止进程，另一个会让 App 清理永久等待。仅处理外围门禁不能接受。

## 4. 设计细节

### 4.1 Core Server Promise 观察

`executeStart()` 每次取得 `invokeStart()` 返回值后，先对同一个 Promise 安装空 rejection observer，再放入 `serverPromises`。observer 只阻止宿主把暂时无人监听的 rejection 判定为 unhandled，不吞掉原 Promise 的 rejected 状态；`firstServerFailure` 与最终 `Promise.allSettled` 继续读取原错误身份和聚合顺序。

回归使用真实 Promise 调度：一个 Server 立即拒绝，`afterStart` 延迟，监听 `unhandledRejection` 并断言计数为零，同时断言 `app.run()` 仍以原 Error 拒绝。

### 4.2 Node Web startup clean stop

Runtime 增加一个私有、一次性的 startup admission settlement 函数。`startServer()` 创建 admission 时安装该函数；正常 listen、startup failure 或 clean stop 任一胜出后立即清空。

owner stop 在 `starting` 状态首次认领 terminal 时调用 clean settlement：

- 移除 startup cancellation listener；
- 释放 Context `afterFunc`；
- resolve admission，让 `running = admission.then(() => donePromise)` 继续等待真实 native terminal；
- 禁止迟到的 listen callback 再写回 `running`。

不增加“取消启动”公共错误。主动 clean stop 应让 start 与 stop 最终都 resolve；真正的 listen、Context 或 cleanup failure 仍走既有稳定错误账本。

### 4.3 依赖安全

根 manifest 使用精确 override：

- `fast-uri` 使用 Ajv 3.x 兼容范围内的最新修复稳定版 `3.1.4`；
- `vite` 使用 VitePress 插件 peer range 可接受且覆盖当前公告的 Vite 6 修复版 `6.4.3`。

不升级到 VitePress 预发布版，不强行使用 Vite 7/8。`bun audit` 加入根 verify；`verify:doc`、类型检查和完整 verify 证明 override 的实际兼容性。若 VitePress 构建不通过，则撤回 Vite override，并把该项报告为上游稳定版阻塞，不能伪造清零。

### 4.4 Examples 验证语义

`test:examples` 改为运行每个 example 的 `test` 脚本，并移除会静默跳过缺失脚本的 `--if-present`。Workspace 契约同时要求每个 example 声明非空 `scripts.test`，使结构检查与真实执行都保持 fail-closed。Coverage 报告可继续由单个 example 的 `test:coverage` 按需执行，但不再让根门禁暗示未定义的统一阈值。

发布阻断证据保持三层：

1. 每个 example 的业务测试；
2. 无外部依赖程序的真实启动、HTTP 探测、SIGTERM 与端口释放；
3. 需要外部服务案例的固定版本 Docker E2E 与 owner cleanup。

### 4.5 Release preflight

在 dirty tree 与 changeset 检查之外，依次要求：

1. 当前 symbolic branch 为 `main`，detached HEAD 拒绝；
2. `main` 的 upstream 精确为 `origin/main`；
3. `git fetch --quiet origin main` 成功；
4. `HEAD`、upstream 和 `refs/remotes/origin/main` 为同一 commit。

测试使用临时本地 bare remote，不依赖公网。错误分支、detached、ahead、behind 与错误 upstream 都必须 fail-closed。

### 4.6 文档事实

- 根 README、默认与简体中文 Getting Started、`@go-like/create` README 明确当前 npm 未发布，并提供仓库内验证命令；发布完成后才能移除提示。
- Examples 统一描述为“仓库工作区内可独立启动的 private workspace 小程序”，不暗示复制单目录后可独立安装。
- 八个 locale 的 package reference 必须包含 46 个公开 package token；测试从 workspace manifest 动态取得事实源。
- `docs/example-portfolio.md` 的 tier 与 `examples/catalog.json` 对齐。

CLI 默认语言、44 个 example 的目录数量、gRPC/Proto、Event Store/replay、更多 Registry provider、inner Docker runner 的 signal framework 和 npm CLI 固定依赖均不在本轮新增。官方 Docker gate 已有外层 signal owner cleanup；没有证据要求再复制一套内层协议。

## 5. 验收

每个行为修复先执行旧实现失败的测试，再实施最小代码并执行定向绿灯。最终执行：

```sh
bun audit
bun run verify:doc
bun run fmt:check
bun run verify:workspace
bun run verify:manifests
bun run verify:file-inventory
bun run verify
git diff --check
```

完整 verify 已包含真实 Docker suite。最终还要按 go-like owner label 回读 container、network、volume，确认本轮 owner 资源零残留。任何命令未运行、失败或仍在运行时，不宣称完成。
