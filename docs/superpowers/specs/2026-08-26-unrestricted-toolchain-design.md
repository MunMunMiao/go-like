# go-like 工具链无版本门禁设计

日期：2026-08-26

状态：已实施；原 Release 方案已被后续删除自动发布流程的决定取代

范围：实施记录基于原 `codex/p0-readiness-docs` 隔离工作树；后续提交与推送另经主人明确授权。

## 1. 背景与结论

实施前，仓库曾在多个层面把特定工具版本写成执行资格：

- 根 `package.json` 通过 `packageManager` 声明精确 Bun 版本；
- Verify 与 Release workflow 固定 runner、Bun、Node 和 npm 版本；
- E2E preflight 探测 Bun、Node、Deno、TypeScript 和 Docker 后，会在 Bun、Node 或 TypeScript 版本不匹配时阻止任何 consumer 启动；
- soak preflight 会拒绝与固定值不同的 k6 版本；
- canonical 文档、发布说明和部分 package README 把这些值写成 supported matrix、release lane 或 required check。

本轮将策略改为：

> 工具是否可用、命令是否成功和实际能力是否满足，可以决定一次执行是否继续；版本号本身不能决定执行资格。

实现继续记录本次运行实际观察到的工具版本，但不再把观察值与 required range 比较。依赖版本、lockfile、GitHub Action SHA 和可复现实验使用的固定 Docker/第三方 fixture 不属于运行门禁，保持不变。

## 2. 边界定义

### 2.1 必须移除

- `packageManager`、`engines`、`volta`、`devEngines` 或同类工具链版本资格声明；
- CI 中固定 Bun、Node、Deno、npm 或 runner 版本的输入与名称；
- 任何根据 Bun、Node、Deno、TypeScript、Docker 或 k6 版本号拒绝执行的分支；
- public/canonical 文档中的 supported version matrix、required version、release version lane 和版本化 required-check 名称。

### 2.2 必须保留

- `dependencies`、`devDependencies`、`peerDependencies`、workspace package version、`overrides` 和 `bun.lock`；
- GitHub Action 的 commit SHA，作为第三方 action 的供应链固定；
- provider、协议、安全和 soak 场景使用的 Docker image digest 与第三方 fixture 版本；
- 工具缺失、启动失败、超时、异常终止、非零退出和实际 consumer 失败的检查；
- 历史设计、实验、比较和执行记录中的实际版本事实；
- 新执行记录中的实际版本观察值。

### 2.3 版本观察不是限制

一次 run record 可以写出实际 Bun、Node、Deno、TypeScript、Docker 或 k6 版本，因为证据必须描述真实环境。该值只能回答“这次在哪个环境运行”，不能回答“其他版本是否允许运行”。

## 3. 方案选择

### 方案 A：取消资格门禁，保留能力检查与观察记录

删除所有 required-version 比较；工具探针只确认所需命令可运行，并以 best-effort 方式记录输出。保留依赖和 fixture 固定。

这是批准方案。它完整满足“都不要限制”，同时不破坏安装与测试输入的可复现性。

### 方案 B：只删除 manifest 与 CI 固定值

改动较少，但 E2E 仍会因版本差异阻止 consumer，文档也会继续暗示支持范围。该方案不能满足目标。

### 方案 C：连依赖、Action SHA 和 fixture 都改为浮动

它会让安装结果、供应链输入和真实服务测试随时间漂移，无法稳定复现失败。该方案明确排除。

## 4. Manifest 与 CI

### 4.1 根 manifest

从根 `package.json` 删除 `packageManager`。不新增替代版本文件，也不修改 dependency ranges 或 lockfile。

`bun install --frozen-lockfile` 仍是安装门禁：它验证已提交依赖解析，而不是验证 Bun 自身版本。

### 4.2 Verify

`.github/workflows/verify.yml`：

- job 名改为不含版本的 `Verify`；
- runner 改为 `ubuntu-latest`；
- `oven-sh/setup-bun` 保留 pinned action SHA，但不传 `bun-version`。

setup-bun 在没有显式版本、`packageManager` 或 `engines.bun` 时使用 latest。权威说明：
[oven-sh/setup-bun](https://github.com/oven-sh/setup-bun/blob/main/README.md)。

### 4.3 Release

本节记录最初批准的实现方案。随后主人决定完全删除 Changesets 与自动发布 workflow，因此当前实现不再保留下述 Release 流程；该取代不影响 Verify、CodeQL 与运行时观察策略。

`.github/workflows/release.yml`：

- runner 改为 `ubuntu-latest`；
- setup-bun 不传版本；
- setup-node 保留 registry 配置和 pinned action SHA，但不传 `node-version`；
- setup-deno 显式使用 `latest` channel，避免其无输入时默认选择一个 major range；
- 删除固定 npm 版本的全局安装步骤，使用 runner/setup-node 提供的 npm；
- 保留 OIDC、bootstrap、frozen install、audit、publish 和 tag 流程。

setup-node 的 `node-version` 输入允许为空；setup-deno 的 `latest` 表示最新稳定发行，而不是固定版本。权威说明：

- [actions/setup-node](https://github.com/actions/setup-node/blob/main/README.md)
- [denoland/setup-deno](https://github.com/denoland/setup-deno/blob/main/README.md)

### 4.4 CodeQL

`.github/workflows/codeql.yml` 的 runner 改为 `ubuntu-latest`。Action SHA、语言选择和权限保持不变。

## 5. E2E 工具 preflight

### 5.1 保留工具需求

`SuiteDefinition.requiredTools` 与 `requiredToolsForPlan(...)` 继续存在。它们表示所选 lane 实际需要哪些命令，不表示支持版本矩阵。

### 5.2 删除版本资格

`e2e/runtime-versions.ts`：

- 删除 `RequiredRuntimeVersions`；
- `RuntimeVersionObservation` 只保留 `tool` 与实际 observation，不再包含 `required`；
- 删除 `requiredVersion`、`matchesRequiredVersion` 和 `assertRequiredRuntimeVersions`；
- 删除会因输出不符合精确 semver 格式而失败的 parser；
- 保留固定顺序、超时、异常终止、非零退出和 bounded diagnostics；
- 成功命令的输出只做单行、长度有界的 best-effort 归一化；任意非空格式记录归一化首行，空输出记为 `unreported`，两者都不阻止 consumer；
- preflight 日志只输出实际 observation，不再输出 `required=...`。

`e2e/executor.ts` 删除版本断言调用。执行顺序保持：

1. 校验 selected plan；
2. 完成 process/platform preflight；
3. 探测 selected plan 所需工具是否可运行；
4. 写出实际 observation；
5. 启动 consumer；
6. 保留原有 result、cleanup、containment 和 residual 判定。

### 5.3 k6

`e2e/soak.ts`：

- 保留固定 `K6Image` digest，它是 soak 的可复现实验输入；
- 删除 `K6Version` required value 和精确相等比较；
- k6 `version` 命令仍必须成功；
- 版本输出只作为有界 evidence 写入 `SoakResult.environment.k6Version`，未知格式不因版本原因失败。

Docker image 无法启动、命令超时、非零退出、结果结构错误或 cleanup 失败仍然失败。

## 6. 测试策略

行为修改遵循 TDD。

### 6.1 先写失败测试

`test/e2e-runtime-version.test.ts`：

- 任意 Bun、Node、Deno 和 TypeScript 版本输出都允许 consumer 启动；
- 未知但成功的版本输出不阻止 consumer；
- 工具探针超时、异常终止或非零退出仍阻止 consumer；
- preflight 记录实际 observation，且不包含 required range。

`test/e2e-soak-lifecycle.test.ts`：

- 不同 k6 version 输出仍通过 preflight 并被记录；
- k6 command failure、timeout 和 cleanup failure 仍失败；
- 固定 image 与 workload argv 保持不变。

同步删除 `test/e2e-runtime-plan.test.ts` 与 `test/e2e-process-supervision.test.ts` 中不再使用的 required-version imports。fixture `e2e/fixtures/runner/version-preflight.ts` 保留 consumer marker 证明，但语义改为“工具可运行后 consumer 启动”。

### 6.2 验证命令

最小验证：

```sh
bun test --isolate --no-orphans test/e2e-runtime-version.test.ts test/e2e-soak-lifecycle.test.ts
bun run typecheck:root
bun run fmt:check
bun run doc:build
git diff --check
```

安装与完整验证：

```sh
bun install --frozen-lockfile
bun run test:unit
```

删除 `packageManager` 后 `bun.lock` 必须保持不变。实施前完整 unit 曾存在已在未修改 `main` 复现的 POSIX controller baseline failure；实施时必须重新执行并准确报告，不能把定向测试通过表述成全库 unit 通过，也不能越权修改该基础设施。

## 7. 文档迁移

以下 active/canonical 文档必须从“版本资格”改为“工具可用性 + 实际观察”：

- `e2e/README.md`
- `doc/guide/getting-started.md`
- `doc/guide/zero-to-one.md`
- `doc/ar-Arab/guide/zero-to-one.md`
- `doc/es-Latn/guide/zero-to-one.md`
- `doc/fr-Latn/guide/zero-to-one.md`
- `doc/ru-Cyrl/guide/zero-to-one.md`
- `doc/zh-Hans/guide/zero-to-one.md`
- `doc/zh-Hant-HK/guide/zero-to-one.md`
- `doc/zh-Hant-TW/guide/zero-to-one.md`
- `doc/reference/verification.md`
- `doc/reference/claims.md`
- `docs/editorial-blueprint.md`
- `docs/releases/0.0.1.md`
- `packages/context/README.md`
- `packages/prometheus/README.md`
- `packages/nats/README.md`
- `docs/superpowers/plans/2026-08-26-lifecycle-readiness-error-dx.md`

迁移原则：

- 删除 supported matrix、required version、release lane 和版本化 check 名；
- 明确 selected lane 会检查所需工具能否运行，但不因版本差异拒绝；
- package README 不再把一次测试环境写成支持范围；
- dependency compatibility、上游已知类型问题和固定 fixture 版本继续保留；
- historical `docs/superpowers/**`、dogfood、比较报告和旧 run record 不批量改写；
- 新 run record 仍记录实际版本，且明确它是 observation。

## 8. 工作区与审查

实现最初使用 `/Users/munmunmiao/Documents/web/likego/.worktrees/p0-readiness-docs`，因为
`doc/guide/getting-started.md` 当时包含同一轮尚未提交的 P0 文档修改。最终交付已将这些改动合并到同一受审查分支。

本轮扩展后，原先“仅七份 P0 文档”的最终审查不再覆盖完整 diff，因此必须：

1. 记录新增授权与扩大后的文件范围；
2. 对版本策略修改独立执行实现审查；
3. 对 P0 文档与版本策略的完整 combined diff 再做一次最终审查；
4. 提交、推送、合并或删除 worktree 仍需单独授权；最终交付已取得该授权。

## 9. 明确排除

- 不把 dependencies、devDependencies、peerDependencies 或 workspace package version 改成 `*`、`latest` 或空值；
- 不删除 `bun.lock`，不关闭 `--frozen-lockfile`；
- 不取消 GitHub Action SHA 固定；
- 不浮动 provider、协议、安全或 soak 的 Docker/第三方 fixture；
- 不删除工具存在性、命令成功性、capability、result、cleanup 或 residual 检查；
- 不改写历史设计、历史实验和历史执行记录；
- 不顺带修复 POSIX controller baseline failure；
- 不发布、不部署、不修改 GitHub branch protection。

## 10. 完成标准

1. 根 manifest 不再声明 package-manager/runtime version；
2. Verify 与 CodeQL 不再固定 runner 或工具版本；Release workflow 已按后续决定删除；
3. 任意成功返回的 Bun、Node、Deno、TypeScript、Docker 和 k6 版本观察不会因版本值或格式阻止 consumer；
4. 工具缺失、timeout、异常终止和非零退出仍 fail closed；
5. k6 与 provider fixtures、Action SHA、dependency versions 和 lockfile 保持固定；
6. active/canonical 文档不再声明 supported/required runtime version matrix；
7. 定向测试、root typecheck、formatter、documentation build 与 diff check 退出 0；
8. 完整 unit 重新执行，结果按实际状态报告，并与已确认 baseline 分开；
9. 最终 tracked diff 只包含经批准的 P0 文档、本设计列出的版本策略文件，以及后续明确批准的修复与清理；
10. 提交与推送只在取得明确授权后执行。
