# LikeGo 测试模型与工程门禁收敛设计

日期：2026-07-27

状态：已批准，自审修订

范围：当前 `main` 工作区；不创建 worktree 或功能分支；本设计不发布 npm、不部署服务、不修改远程资源。

## 1. 背景

LikeGo 当前同时存在三套验证形态：

1. 执行模块行为的单元测试；
2. 启动进程、runtime、发布包或真实第三方服务的 E2E；
3. 读取源码、manifest、目录、workflow、覆盖率和测试文件，再与硬编码清单比较的自定义门禁。

第三套形态没有验证 LikeGo 对用户提供的运行行为，而是在证明仓库仍保持某种内部文件形状。它进一步派生出
capability/owner manifest、文件清单、输入哈希、build stamp、动态测试代码、证据 JSON、fixture corpus 与验证器自测，
形成了与微服务工具包并行的“验证工具产品”。这不是 go-micro、go-kratos 或常规 TypeScript 工具包的使用模型，
也显著增加了修改、评审和故障定位成本。

本轮把 LikeGo 收敛为两种测试：单元测试和 E2E。格式检查、类型检查、构建、安全审计与文档构建继续作为工程
命令存在，但不伪装成第三种测试。

## 2. 当前证据

### 2.1 仓库审计

当前 checkout 的只读审计确认：

- 42 个 `source-policy.test.ts`，约 9,384 行，主要使用 TypeScript AST、文本扫描或目录枚举约束源码写法；
- 51 个 `package-contract.test.ts`，约 4,697 行，主要读取 `package.json`、`capability.json`、
  `owner.json`、README、tsconfig 和固定文件清单；
- 47 个 `coverage-contract.ts`，约 2,041 行，在测试运行器已经生成 coverage 后再次解析 LCOV 和源码 inventory；
- `tools/` 下 284 个文件、约 26,400 行，其中 259 个是 gate fixture 或 probe payload；
- `e2e/cases/` 下 81 个 case 文件记录来源、断言和 evidence 映射，但不负责执行真实场景；
- `docs/file-inventory.md` 由仓库代码扫描并生成，又被仓库代码反向检查；
- `@likego/create` 通过 TypeScript 模板生成新的 TypeScript 项目，属于当前产品不需要的 scaffold 能力；
- GitHub Verify 与 Release 当前调用完整 `verify`，因此把 Docker、真实 provider、published runtime 和 E2E 混入
  hosted CI；另有 scheduled soak workflow。

这些数量只用于确定删除边界，不作为以后必须保持的 inventory。

### 2.2 上游对照

调研基于 2026-07-27 获取的最新 `main`：

| 项目 | 提交 | 观察结果 |
| --- | --- | --- |
| go-micro | `9d306dcfc1a912a8a9493f31fee0bb983475258d` | Makefile 将 test、race、coverage、lint、fmt 和集成路径分别表达；产品测试直接执行 Go 行为或真实服务 |
| go-kratos | `668db92c2c001e9552594ba5a8aede8456af6d7e` | Makefile 将 test、coverage、lint、build 分离；测试直接运行 `go test`，服务依赖由真实容器提供 |

两个仓库中均没有 LikeGo 当前的 `source-policy`、`package-contract`、`coverage-contract`、`capability.json`、
`owner.json` 文件体系。上游存在的 Proto 或 CLI generator 不构成 LikeGo 必须实现 generator 的理由；LikeGo 已明确不支持
Proto，并且当前产品目标是微服务工具包而不是项目生成器。

## 3. 目标与非目标

### 3.1 目标

1. 只保留单元测试和 E2E 两种测试语义；
2. 删除读取当前源码或仓库形状来自证正确的门禁；
3. 删除由自证体系派生的 manifest、schema、inventory、evidence 和验证器自测；
4. 删除运行时生成测试源码、consumer 源码和示例项目的路径；
5. 保留并简化真正验证公共行为、发布包和第三方服务组合的测试；
6. GitHub CI 不运行 E2E；CI 无法使用 Docker 完整还原全部 E2E 环境，Docker 和其他 E2E 只由本地显式命令执行；
7. 继续使用 Bun workspace 命令统一运行包级任务；
8. 保持现有微服务运行时公共 API 与 provider 能力不变。

### 3.2 非目标

- 不借本轮修改 Core、Context、Server、Transport、Registry、Config、Store、Broker 等公共运行语义；
- 不增加测试框架、schema validator、代码生成器或自制 linter；
- 不使用 GitHub CI 执行 Docker、published runtime matrix、examples runtime 或 soak；
- 不删除真实错误处理、安全边界、资源清理和跨 runtime 行为测试；
- 不为了保住历史覆盖率数字编写无行为价值的测试；
- 不重写历史设计文档，历史文件继续作为当时决策记录存在。

## 4. 最终验证模型

### 4.1 工程命令

以下命令是工程检查，不属于测试分类：

```text
fmt / fmt:check
typecheck
build
audit
doc:build
```

- `fmt` 只调用 oxfmt；
- `typecheck` 只调用 TypeScript 编译器和 workspace `typecheck`；
- `build` 只调用 workspace package 的 tsdown build；
- `audit` 使用包管理器的依赖审计；
- `doc:build` 使用 VitePress 真实构建文档。

不得再为这些配置编写“读取配置文本并断言固定字符串”的测试。

### 4.2 单元测试

根命令统一为：

```text
test:unit
test:unit:coverage
```

根 `test:unit` 使用 Bun workspace 命令执行根级、所有 packages 和所有 examples 的单元测试。workspace 的测试脚本
统一命名为 `test:unit`；不存在仅为兼容旧命令保留的 `test` 别名。

单元测试必须导入可执行模块并验证行为。允许使用：

- 内存实现、fake、mock 和注入时钟；
- 临时目录、临时文件和本机 loopback listener；
- 对异常、取消、生命周期、并发和资源释放结果的断言；
- 公开类型 consumer，由 `tsc` 在 `typecheck` 中编译。

单元测试不得：

- 读取当前 `src/**/*.ts` 并检查 AST、字符串、注释或语法风格；
- 枚举当前目录后断言精确文件数量和文件名；
- 读取 workflow、README、package manifest 后复制其完整内容作为期望值；
- 解析 LCOV 来证明每个生产文件都出现在自定义 inventory；
- 检查测试源码是否包含某个字符串；
- 通过生成代码来制造被测 consumer。

Coverage 只是单元测试的一种运行报告。可以使用 Bun 原生 `--coverage`，但不再维护自定义 LCOV parser、源码
inventory 或 100% 形式门禁。

### 4.3 E2E

根命令统一为：

```text
test:e2e
test:e2e:<scope>
```

以下场景归为 E2E：

- 启动 Node、Bun 或 Deno 子进程并从公开入口调用包；
- 启动可运行 example，完成 HTTP 或业务调用，再验证 SIGTERM 和端口释放；
- 使用 Docker 启动 RabbitMQ、Redis、Consul、etcd、Vault、Kubernetes、ZooKeeper、NATS、OTel 等真实服务；
- 构建 tarball，在隔离目录安装后从用户视角 import、typecheck 和运行；
- 长时间负载、故障恢复、failover 和资源残留检查。

原有 `smoke:*`、`test:docker`、`integration`、`test:published` 等命令按实际边界并入 `test:e2e:*`，不再形成第三种
测试类型。目录可以继续按 provider 就近放置，但命令语义必须统一。

E2E 可以生成构建产物、tarball、coverage 或服务数据；不得动态生成 TypeScript/JavaScript 测试源码。published
consumer 和跨 runtime consumer 改为版本库中的静态 fixture。

## 5. 删除边界

### 5.1 源码与仓库形状自检

整类删除：

- 所有 `source-policy.test.ts`；
- 所有 `package-contract.test.ts`；
- 根级 `repository-contract.test.ts`、`ci-workflow.test.ts`、`doc-site.test.ts`；
- 混合行为测试中读取源码、workflow、README 或其他测试文件的 test block；
- `verify-workspace`、`verify-example-programs`、`format-scope` 和生成式 file inventory 链；
- `changeset-required`、`release-preflight` 及其读取 Git diff、workspace 或 workflow 的自定义检查；
- 自制相对 import、global、JSDoc、spread、class、type assertion 与 runtime global 扫描器。

格式由 oxfmt 管理，类型与 module resolution 由 TypeScript 管理，tracked file inventory 由 Git 管理，workspace
执行由 Bun 管理。项目不再复制这些工具的职责。

删除 private `@likego/testing` workspace。它只有一个真实消费者，listener 生命周期断言直接收回对应的
`@likego/transport-http` 单元测试；不再用一个独立 package 测试测试工具本身。

### 5.2 Manifest 与 evidence 自证体系

删除：

- 每个 package 的 `capability.json` 和 `owner.json`；
- 对应 schema、capability vocabulary、manifest validator 和 fixture；
- `tools/gates` 的 result protocol、atomic writer、protocol probe 和 fixture corpus；
- `tools/boundaries` 的 module syntax、semantic global、project session 及其 fixture/probe；
- `tools/workspaces` 的自制 workspace discovery；根任务统一使用 Bun workspace 命令，tsdown 只处理当前 cwd package；
- runtime manifest、official manifest evidence 和输入 hash；
- `docs/file-inventory.md`、当前态 evidence matrix 中仅服务该体系的内容；
- GitHub artifact upload 中只服务这些内部 gate JSON 的部分。

公共能力由 TypeScript API、README 和真实行为测试表达。资源 ownership 由实际 start/stop 实现与 E2E cleanup 证明，
不再维护第二份 JSON 声明。

### 5.3 Coverage 自证体系

删除 47 个 `coverage-contract.ts`、workspace coverage aggregator、源码函数 inventory 和 coverage evidence parser。
包级 `test:unit:coverage` 直接执行 Bun 原生 coverage；不要求每个 package 或 example 通过 100% 形式阈值。

### 5.4 E2E evidence overlay

删除：

- `e2e/cases/*.case.ts`；
- migration baseline；
- sourced inventory、case provenance、claim 映射和精确 case 数量检查；
- 只保存、解释或再次检查 suite 输出的 evidence overlay。

保留并简化真正启动服务、调用 API 和回收资源的 suite/harness。根 runner 只负责选择 E2E scope、串并行执行和返回
进程退出码，不生成第二份事实账本。

### 5.5 项目代码生成

删除整个 `@likego/create` package，以及 README、站点、release notes、workspace references、Changesets 和 published
E2E 中对它的引用。LikeGo v1 不提供 scaffold、模板引擎或源代码生成能力。

examples 继续作为版本库中可直接运行的小程序，由维护者正常编写和审查，不通过 generator 产生。

## 6. 构建与发布边界

TypeScript 必须生成可发布 JavaScript 和 declaration，因此以下属于正常构建，不是产品代码生成：

- tsdown 将 `src/*.ts` 编译为 `dist/*.js`；
- tsdown 生成 `dist/*.d.ts`；
- 构建复制 README 和 LICENSE；
- 参照 ck-orm 的已批准方式，构建结束写入最小 `dist/package.json`。

构建收敛为每个 publishable workspace 的 `build`，由根命令使用 Bun workspace filter 顺序执行。tsdown 自身的
`clean: true` 负责清理该 package 的输出，不再维护跨仓库 `clean-generated` 扫描器。

删除：

- `annotate-dist` 生成的 `@ts-self-types` header 和 declaration companion JavaScript；
- 解析生成代码 AST 的 `verify-dist`；
- published build stamp、整仓输入 hash 和反复 digest；
- runtime/type E2E 中动态写出的 consumer 源码。

`dist/package.json` writer 只承担发布目录重写：exports 指向 `.js`/`.d.ts`、移除开发字段、把 workspace dependency
转换为实际版本。不得演变为仓库策略验证器。

发布正确性由静态 consumer fixture 完成真实 `pack -> install -> import/typecheck/run` E2E 验证。

## 7. GitHub 与本地执行

### 7.1 GitHub Verify

GitHub Verify 只执行：

```text
bun install --frozen-lockfile
bun run fmt:check
bun run typecheck
bun run build
bun run test:unit
```

其中只有 `test:unit` 是测试。不得启动 Docker、第三方服务、跨 runtime E2E、published E2E、examples E2E 或 soak。
CI 无法用 Docker 完整还原全部 provider、网络、故障恢复和资源清理场景，因此不得挑选部分 E2E 放入 CI 后将结果
表述为 E2E 通过。CodeQL 可以继续作为独立安全分析 workflow，它不是 E2E。

### 7.2 GitHub Release

Release 保留 trusted publishing、OIDC、npm provenance、Changesets 和 tag 流程。发布前只执行与 Verify 相同的工程
检查和单元测试，不调用 E2E。workflow checkout 的 ref 和 GitHub 事件已经确定发布来源；不再维护读取 Git、源码、
workspace、workflow 或 Changesets 状态的 TypeScript/shell preflight，也不得把已删除检查改写成 shell gate。

### 7.3 本地 E2E

所有真实组合验证由开发者在具备完整 Docker 条件的本地受控环境显式执行：

```text
bun run test:e2e
bun run test:e2e:providers
bun run test:e2e:examples
bun run test:e2e:published
bun run test:e2e:runtimes
bun run test:e2e:soak
```

最终名称可按现有实际场景最小化，但不得恢复 inventory、smoke 或 evidence 类型。`test:e2e` 必须覆盖完整的有限
时长 E2E 集合，不提供一个被 CI 误用的缩减版。Docker E2E 必须继续使用固定镜像、真实 health/readiness、超时、
退出码和 owner cleanup；完成后回读 container、network 和 volume 为零残留。

删除 `.github/workflows/soak.yml`。本地 soak 仍属于 E2E，但通过 `test:e2e:soak` 单独显式执行，不计入默认的有限时长
`test:e2e`，也不由 GitHub CI 调度。

## 8. 实施策略

采用一次性模型收敛，不采用只改命令名称、保留旧基础设施的兼容层。实施按依赖方向分为四个连续阶段：

1. 删除自证体系和 `@likego/create`，清理 workspace、依赖和文档引用；
2. 从现有测试中保留真实行为单元测试，统一 package 和 root 的 `test:unit`；
3. 保留真实 E2E harness，删除 evidence overlay，并用静态 consumer fixture 重建 published/runtime E2E；
4. 简化构建、GitHub workflow 和根 scripts，完成全量工程检查与本地真实 E2E。

这些阶段属于同一交付，不在中间状态宣称完成。每个阶段都先运行受影响的最小测试，避免把业务回归隐藏在大规模删除中。

## 9. 风险与控制

| 风险 | 控制 |
| --- | --- |
| 删除静态 policy 后重新引入 runtime-specific API | TypeScript 配置、package 边界和 Bun/Node/Deno published E2E 直接证明兼容性 |
| 删除 manifest 后遗漏发布入口 | 静态 consumer fixture 从每个支持的公开入口 import，并对真实 tarball 执行 typecheck/run |
| 大规模删除误伤行为测试 | 以“是否执行产品行为”为准逐文件分类；混合文件只删除静态块 |
| E2E runner 简化后漏跑 provider | 根 `test:e2e` 对列入 scope 的 workspace 显式调用 `test:e2e`；命令缺失或执行失败时直接失败 |
| 移除 build annotation 后 Deno 类型解析失败 | 在临时目录安装真实 tarball 并执行 Deno import 与 typecheck；失败则修正标准 package exports，而不恢复源码扫描器 |
| GitHub 不跑 E2E 导致合并前缺少环境证据 | 这是已批准边界；实际命令和结果只在当次人工交付报告中说明，不写入仓库、不上传 artifact、不形成发布 gate |

## 10. 验收标准

结构验收：

1. 根和 workspace 的当前 package scripts 只出现 `test:unit*` 与 `test:e2e*` 测试命令；
2. 可执行源码、当前配置、workflow 和当前用户文档中不再存在 `source-policy`、`package-contract`、
   `coverage-contract`、`smoke`、E2E inventory 或 evidence gate；
3. 当前 package/workspace 不再存在 `capability.json`、`owner.json`、`docs/file-inventory.md`、内部 gate
   schema/fixture/probe；
4. 当前 package/workspace 和用户文档不再存在 `@likego/create` 或任何生成项目/测试源码的实现；
5. GitHub workflow 不调用任何 E2E、Docker 或 soak 命令。

`docs/superpowers/specs/`、`docs/superpowers/plans/` 和历史 release 记录只保存当时决策，不属于上述当前态验收范围。
实施完成时只执行一次只读检查确认删除结果，不为这些条件新增持久源码扫描 gate。

行为验收：

```sh
bun install --frozen-lockfile
bun run fmt:check
bun run typecheck
bun run build
bun run test:unit
bun run test:e2e
git diff --check
```

发布前或明确要求长时间验证时，另行执行 `bun run test:e2e:soak`；它仍是 E2E，不是第三种测试类型。

其中 `test:e2e` 必须在本地使用真实 Docker 服务完成，不能用 mock 替代已经纳入范围的 provider。所有命令必须等待
实际退出并记录退出状态；任何失败、超时、仍在运行或未执行的命令都必须如实报告。最后检查 Git diff、工作区状态和
Docker owner 资源残留。

完成本设计只能证明 LikeGo 回到清晰、可维护的验证模型。生产级结论仍取决于公共 API 正确性、真实 provider E2E、
发布包 consumer 验证与持续运行证据，不能由文件数量、覆盖率数字或自生成 evidence 替代。
