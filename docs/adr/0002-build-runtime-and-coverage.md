# ADR 0002：构建、运行时与测试

日期：2026-07-17

状态：已接受

## 背景

LikeGo 使用 Bun 管理 monorepo，但发布包需要在支持其公共 API 的 Node.js、Deno 与 Bun 后端中使用。开发时的
workspace 源码解析、发布包构建和真实服务验证是不同职责，不应由额外生成物串在一起。

## 决策

1. Bun 是包管理器、workspace 调度器、脚本运行器和单元测试运行器；提交 `bun.lock`，安装使用
   `bun install --frozen-lockfile`。
2. 每个发布包从自身目录调用 `tsdown`。根 `bun run build` 只使用 Bun workspace 顺序调度包级 `build`，不在
   根目录重新实现依赖图或构建器。
3. `tsdown.config.ts` 从当前包的 `exports` 派生入口，输出 neutral ESM 与 DTS；workspace、peer、optional
   dependency 和 `node:` builtin 保持 external，不生成 min bundle。
4. 构建产物包含公开 JS/DTS 入口、可达 chunk、包级 `README.md`、`LICENSE` 和最小
   `dist/package.json`。发布 manifest 只保留运行时所需字段，并把 workspace dependency 解析为真实版本。
5. 源码 manifest 的 export 指向 `src`，供 workspace 开发；发布 manifest 的 export 指向包根 JS/DTS，供安装
   后消费。`dist` 是可删除的构建产物，不作为源码类型检查或单元测试输入。
6. TypeScript 负责声明与类型检查。portable 入口只使用 ECMAScript 与标准 Web API；Node listener、进程信号、
   UDP、文件监听或第三方原生 SDK 放在显式 runtime 子路径或 provider 包。
7. 测试只分为单元测试和 E2E：
   - `test:unit` 运行不依赖外部服务的确定性测试；`test:unit:coverage` 仅输出覆盖率，覆盖率不是独立测试类型。
   - `test:e2e` 在本地验证真实 provider、跨运行时、可执行 example 与发布 tarball consumer；
     `test:e2e:soak` 是独立的长时间 E2E。
8. CI 只执行安装、`fmt:check`、`typecheck`、`build` 和 `test:unit`。Docker、跨运行时、example 进程和 soak
   不在托管 CI 中运行，避免把不完整环境的结果当作真实 E2E。
9. `oxfmt` 是唯一格式化工具。`fmt`、`typecheck`、`build`、`audit` 和 `doc:build` 是工程命令，不命名为测试。
10. 公共包从 `0.0.1` 起步，由 Changesets 管理版本。`release` 在发布前重新执行格式检查、类型检查、构建与
    单元测试，再调用 Changesets；npm trusted publishing 与 provenance 由 Release workflow 承接。

## 后果

- 包级构建可以独立复现，根脚本只负责 workspace 调度。
- 单元测试快速且确定；需要真实运行时、进程或中间件的行为明确放入本地 E2E。
- 发布包是否可安装由真实 tarball consumer 验证，不再并行维护生成式仓库自检。
- 具体 runtime/provider 的支持范围仍由其公共文档和真实 E2E 说明，不因删除仓库自证文件而扩大。
