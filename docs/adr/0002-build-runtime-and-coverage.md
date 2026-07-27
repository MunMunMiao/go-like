# ADR 0002：构建、运行时矩阵与覆盖率

日期：2026-07-17

状态：已接受

## 背景

LikeGo 使用 Bun 进行开发和单元测试，但可移植包需要供 Node、Deno 和 Bun 使用。直接发布 TypeScript
源码，或将工作区依赖打包到下游，都会破坏 npm 使用体验，并可能复制 Context 哨兵对象。Bun `1.3.14`
的覆盖率只输出行和函数计数器，且未加载的文件不会进入分母。

## 决策

1. Bun `1.3.14` 是包管理器、脚本运行器和单元测试运行器；提交 `bun.lock`，CI 第一步执行 `bun ci`。
2. npm TypeScript `7.0.2` 是声明和类型检查的权威；Deno 内嵌编译器检查是额外的兼容性门禁。
3. 精确锁定 `tsdown 0.22.14`，通过 Bun native config loader 为 46 个可发布工作区生成 neutral ESM bundle 与
   declaration bundle。每个公开 export 和声明的 CLI bin 都有独立入口；构建启用 clean、DTS，并复制包级 `README.md` 与
   `LICENSE`。`target:false` 不擅自降级标准 Web API，也不生成 `.min.js`、`unpkg` 或 `jsdelivr` 压缩通道。
   根构建使用 `bun run --filter './packages/**' build` 按工作区依赖图调度每包构建，不在根层重复调用 tsdown
   或补单包特例。`dist` 只是构建、打包和发布验证的瞬态输出，必须被 Git 忽略；开发类型检查和单元测试
   不得将其作为输入。
4. workspace dependency、peer dependency、optional dependency 与 `node:` builtin 均保持为外部依赖；禁止把
   `@likego/context` 打进其他 bundle，必须保证跨包哨兵对象标识一致。共享 chunk 只允许由公开入口的运行时图
   或声明图可达，孤儿 chunk 直接导致构建验证失败。
5. 生产、测试与工具 TypeScript 的内部相对导入不写任何扩展名。开发解析使用 TypeScript
   `moduleResolution: "Bundler"` 与指向工作区 `src` 的 `paths`；禁止手写 `.js`、`.mjs`、`.cjs`。
   tsdown 直接从公开 export 清单派生入口并生成带 `.js` specifier 的 bundle，不改写源码。私有 example 只做
   `noEmit` 类型检查和测试，不进入 project references、发布 build 或版本图；它们通过公共包名消费 workspace
   源码，并由真实运行与 Docker 门禁证明组合关系。
6. 生成步骤为每个公开 JS 入口添加相邻 `@ts-self-types` 声明；可执行入口存在 shebang 时，shebang 必须保持
   第一行，self-types header 位于第二行。若 declaration bundle 拆出只含类型的 hash
   chunk，则生成内容严格等于 `@ts-self-types` header 加 `export {}` 的同 stem JS companion；它只解决 Deno
   对 d.ts 内 `.js` specifier 的真实文件解析，不进入运行时入口可达图，也不能夹带运行时代码。验证器同时
   要求声明引用的 `.js` companion 与 `.d.ts` 目标存在，并拒绝错误 header、内容漂移与孤儿产物。
7. Bun 单元覆盖率按包生成 LCOV，并强制函数覆盖率 100%、源码清单精确匹配且每个可执行文件都有非零行分母；
   根命令使用 `bun run --filter './packages/**' --sequential test:coverage` 调度 46 个发布包和一个内部测试
   workspace，LikeGo 自有脚本只读取 46 个发布包的
   产物并验证 LCOV 契约，不重复实现 workspace 任务分发。
   canonical workspace discovery 会识别 `packages/*` 以及 cache、config、registry、store、transport 的显式嵌套 workspace，
   再把每个发布包的 `src/**/*.ts` 与 LCOV `SF` 对照，任何未加载文件、空执行分母或未命中函数都直接导致失败。
   默认仍要求 `LF=LH`。Bun `1.3.14` 在 `oxfmt 0.60.0` 格式化后的括号、续行和 `catch` 行上存在不稳定的
   行归属；目前只允许 `@likego/registry-mdns` 的
   “包名 + 源文件 + 行号 + 精确文本 + 相邻已命中锚点”例外，并绑定 Bun `1.3.14`。例外集合必须与当次
   未命中集合完全相等；任何新增、消失、移动、文本或锚点漂移都 fail closed。原始 `LF/LH` 继续留档，
   也不为追平计数删除防御分支。
8. Bun `1.3.14` 不生成分支计数器，`branches=1.0` 也不能作为有效门禁；Bun 证据固定记录
   `branches:{supported:false,percent:null,reason:"BUN_1_3_14_NO_BRANCH_COUNTER"}`。可移植包的
   已发布 JavaScript 原生数值证据来自 Node `24.18.0`、Node `26.5.0` 与 Deno `2.9.4`。
   运行时专用包只运行其 capability manifest 声明支持且具备原生数值分支覆盖率的 `exact` 运行时条目；
   例如仅支持 Node 的适配器只生成 Node 证据，不虚构 Deno 支持。发布包的行为结果、可达 JavaScript 清单与
   每文件非零行分母是阻断门禁；Node 与 Deno 对同一 bundle 的行、分支、函数归属及分母并不稳定，因此三项
   百分比按文件和 aggregate 原样留档，不设武断阈值。每文件原始 found/hit 计数与 aggregate 计数一并写入
   门禁结果，所有 hit 大于 found 的不可能计数都在计算百分比前拒绝。源码函数完整性仍由第 7 条的逐包
   `src/**/*.ts` 门禁强制为 100%；发布 smoke 负责证明真实安装后的具名公共行为，不把 bundler 与 profiler
   生成的内部函数边界重复当成产品契约。不使用 `c8` 或其他补充插桩器，也不得把这些原始数值包装成
   “100% coverage”。
9. 可移植包的共享行为用例在 Node LTS/current、Deno exact、Bun exact 上对构建输出运行；运行时专用包
   运行 capability manifest 中所有声明支持的 `exact` 条目。运行器适配器使用各自的原生测试 API，生产代码
   不得出现运行时条件分支。
10. 根聚合覆盖率只计入被根测试加载的公共包生产实现与普通工具实现。`**/test/**` helper、`e2e/**` 真实套件、
    `examples/**` 私有应用、`scripts/soak.cli.ts` 生产 soak 编排和 `scripts/published/**` 跨运行时编排不进入该分母：
    测试 helper 不是生产代码，私有 example 由独立 workspace 单测、Node E2E 和真实 Docker 门禁负责，production
    soak 编排由 evaluator/CLI 契约测试与真实 60 分钟 Docker 作业负责，其余两类分别由完整的来源化 E2E 门禁
    与仅按包名加载的已发布 runtime/type 门禁直接执行。该排除不适用于任何发布 workspace 的
    `src/**/*.ts`；包括 `packages/config/consul`、`packages/registry/{consul,mdns}` 与
    `packages/transport/{http,memory}`，这些文件仍由逐包源码清单、默认完整行覆盖、三个精确归属例外和 100% Bun
    函数覆盖门禁强制审计，并由已发布包的原生运行时保留行、分支和函数证据。根聚合自身只以函数覆盖率
    阻断；普通工具中的格式行保留在根 LCOV 中，由相应行为测试负责。
11. 每个公共工作区的源码 `package.json` 是开发契约：`module` 与 `typings` 指向 `src/index.ts`，每个公开
    `exports` 条目都是指向对应 `./src/*.ts` 的字符串；CLI `bin` 使用 canonical `./dist/*.js` 目标，构建器从
    同 stem 的 `src/*.ts` 派生额外入口并在发布 manifest 中改写为包根 `./*.js`。工作区消费者因此按包名直接解析源码；example 必须继承
    根级 `paths`，不得清空或重复覆盖。构建在每个 `dist` 内生成另一份独立发布契约：公开 export 改写为包根
    `./*.js` / `./*.d.ts` 条件映射，workspace 依赖改写为对应发布包的精确版本，并移除 private、scripts、
    开发依赖与源包 `files` 字段。发布 smoke 不复制工作区文件，也不通过 symlink 使用源码；每个闭包包都以
    `dist` 为 cwd 执行真实的 `bun pm pack`；
    运行器在 monorepo 之外创建一次性 consumer，以 `file:` tarball dependency 执行 `npm install`。安装后
    逐包校验标识和版本、工作区依赖的精确版本改写、无 `workspace:` 残留、非 symlink、所有导出目标存在、
    LICENSE 与仓库一致，并且 tarball 文件表必须与源工作区的 `dist` 文件表完全一致，只能包含
    `package.json`、`README.md`、`LICENSE`、ESM/DTS 入口及其可达 chunk，且不得含任何 `.min.*`。
    runtime 与 type 门禁都只从该安装结果按包名加载；任何暂存、打包、安装、校验或清理失败都会使发布
    门禁失败。
12. 构建印章 schema 2 分别对完整构建输入清单和每包输出计算 SHA-256。输入包括 `bun.lock`、
    根 `package.json`、base/tsdown tsconfig、`tsdown.config.ts`、dist 标注器、dist manifest 生成器、workspace
    discovery，以及所有可发布工作区的 `package.json`、`tsconfig.json`、`README.md`、`LICENSE` 与
    `src/**/*.ts`；输出是每包精确的 JS、DTS、`package.json`、`README.md`、`LICENSE` 文件表及摘要。发布
    门禁在 pack 前重新枚举并计算两侧；配置、锁文件、工具、源码、文档、文件集合或输出的任何漂移都必须
    fail closed。
13. 已发布类型 consumer 使用安装目录自身的 `node_modules/@types` 作为唯一 `typeRoots`，不注入 Bun
    ambient types。只有包 manifest 显式声明 `@types/node` 时才加载 Node globals；因此包必须自行声明其
    生成声明真正依赖的环境类型。NATS `3.4.0` 在 TypeScript `7.0.2` 与
    `exactOptionalPropertyTypes` 下的两个已知上游声明诊断，采用精确版本、精确代码、精确数量和精确文本的
    fail-closed 例外；其余任何诊断均导致失败。
14. 根包与 46 个可发布工作区的初始版本统一为 `0.0.1`；内部 `@likego/testing` 与私有 example 不声明发布
    版本、不生成 `dist`，也不参与发布。精确锁定 `@changesets/cli 2.31.1`，Changesets 只管理 46 个公共工作区，使用官方
    `@changesets/cli/changelog` 生成包级变更日志，内部依赖按 patch 规则更新且不自动提交。公共包的生产、
    optional 与 peer 工作区依赖在源码 manifest 中使用对应包的精确版本；公共包的 dev dependency 和私有
    example 可保留 `workspace:*`。精确依赖允许底层 patch 沿依赖图触发 dependent patch；`fixed` 与 `linked`
    保持为空。`version:packages` 在 `changeset version` 后执行 `bun update --filter '*'`，保证 manifest 与
    `bun.lock` 同步，版本文件、changelog 和锁文件由维护者审查后提交。唯一发布入口 `bun run release` 先执行
    全新 build、dist 验证和构建印章，再运行 Changesets；example 由独立 workspace 测试和 Docker 门禁负责。
    46 个源码 manifest 的
    `publishConfig.directory` 指向 `dist`，供 Changesets 从已验证的扁平目录发布；生成的 dist manifest 只保留
    `publishConfig.access: "public"`，避免递归目录。禁止裸跑 `changeset publish` 绕过这些门禁；源码版本、
    dist 版本或 tag 决策不一致时必须 fail closed。
15. 精确锁定 `oxfmt 0.60.0` 作为唯一格式化工具。`fmt:check` 是根验证门禁；生成目录、覆盖率、测试构建、
    报告、证据、fixture、probe、临时/外部材料和 Git/IDE 目录全部排除，避免重写历史证据或把生成产物当作
    手写工程源码。Changesets 自带的 prettier 步骤关闭，生成的 changelog 由同一 oxfmt 工作流统一处理。

机器可审计的覆盖率契约标记：`LIKEGO_PUBLISHED_JS_BRANCH_AUTHORITY_V1`。

## 覆盖率排除项

允许排除：`.d.ts`、生成的 schema 代码、测试文件、仅供根层使用的 E2E/production-soak/已发布包门禁编排、由同一受审
`src` 构建产生且另有已发布 JavaScript 原生分支权威的 `dist` 输出，以及只有静态 re-export、没有运行时
分支的根 barrel。每一条排除都必须出现在覆盖率策略允许列表中，并由源码清单校验；`dist` 排除不得连带
排除其对应的普通生产 `src` 实现，也不能用宽泛 glob 隐藏其他生产源码。

## 后果

- 仅通过 `bun test --coverage` 或某个原始百分比不足以证明质量；还必须同时通过源码清单与源码函数完整性、
  发布包具名行为、跨运行时执行与真实 E2E 门禁。
- 单元覆盖率、感知 capability 的跨运行时行为、类型导出、故障/恢复和 E2E 是并列门禁，不能互相替代；
  未声明支持的运行时不构成适配器的伪失败或伪成功证据。
- 开发门禁必须先清空全部 `dist`，再让根、E2E 与所有工作区通过公共包名和源码 export 执行 typecheck；
  公共包随后构建，以证明开发解析不依赖历史 `dist`。发布 smoke 必须从按包名真实安装的 tarball 导出加载，
  不能用相对 `dist/*.js` 路径、复制目录、symlink 或工作区源码冒充已发布包。
