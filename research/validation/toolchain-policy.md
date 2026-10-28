# 工具链版本与能力验证的取舍

研究日期：2026-08-26。记录版本资格门禁、能力检查和可复现输入之间的区别；不包含已撤销的自动发布流程。

## 1. 背景与结论

实施前，仓库曾在多个层面把特定工具版本写成执行资格：

- 根 `package.json` 通过 `packageManager` 声明精确 Bun 版本；
- Verify 与 Release workflow 固定 runner、Bun、Node 和 npm 版本；
- E2E preflight 探测 Bun、Node、TypeScript 和 Docker 后，会在 Bun、Node 或 TypeScript 版本不匹配时阻止任何 consumer 启动；
- soak preflight 会拒绝与固定值不同的 k6 版本；
- canonical 文档、发布说明和部分 package README 把这些值写成 supported matrix、release lane 或 required check。

原设计采用的策略：

> 工具是否可用、命令是否成功和实际能力是否满足，可以决定一次执行是否继续；版本号本身不能决定执行资格。

实现继续记录本次运行实际观察到的工具版本，但不再把观察值与 required range 比较。依赖版本、lockfile、GitHub Action SHA 和可复现实验使用的固定 Docker/第三方 fixture 不属于运行门禁，保持不变。

## 2. 边界定义

### 2.1 必须移除

- `packageManager`、`engines`、`volta`、`devEngines` 或同类工具链版本资格声明；
- CI 中固定 Bun、Node、npm 或 runner 版本的输入与名称；
- 任何根据 Bun、Node、TypeScript、Docker 或 k6 版本号拒绝执行的分支；
- public/canonical 文档中的 supported version matrix、required version、release version lane 和版本化 required-check 名称。

### 2.2 必须保留

- `dependencies`、`devDependencies`、`peerDependencies`、workspace package version、`overrides` 和 `bun.lock`；
- GitHub Action 的 commit SHA，作为第三方 action 的供应链固定；
- provider、协议、安全和 soak 场景使用的 Docker image digest 与第三方 fixture 版本；
- 工具缺失、启动失败、超时、异常终止、非零退出和实际 consumer 失败的检查；
- 历史设计、实验、比较和执行记录中的实际版本事实；
- 新执行记录中的实际版本观察值。

### 2.3 版本观察不是限制

一次 run record 可以写出实际 Bun、Node、TypeScript、Docker 或 k6 版本，因为证据必须描述真实环境。该值只能回答“这次在哪个环境运行”，不能回答“其他版本是否允许运行”。

## 3. 方案选择

### 方案 A：取消资格门禁，保留能力检查与观察记录

删除所有 required-version 比较；工具探针只确认所需命令可运行，并以 best-effort 方式记录输出。保留依赖和 fixture 固定。

选择该方案是为了避免把版本观察当作兼容性证明，同时保留安装与测试输入的可复现性。

### 方案 B：只删除 manifest 与 CI 固定值

改动较少，但 E2E 仍会因版本差异阻止 consumer，文档也会继续暗示支持范围。该方案不能满足目标。

### 方案 C：连依赖、Action SHA 和 fixture 都改为浮动

它会让安装结果、供应链输入和真实服务测试随时间漂移，无法稳定复现失败。该方案明确排除。
