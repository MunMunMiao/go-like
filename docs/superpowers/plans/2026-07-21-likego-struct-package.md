# LikeGo Struct Package Implementation Plan

状态：已废弃。`@likego/struct` 已在首发前删除；应用直接使用标准 Web API 与自己选择的 Standard Schema
实现，`@likego/event` 只保留最小实例级 `Codec<T>` 契约。下文仅作为历史实施记录。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Zen Kit 已验证的标准 Web API struct 实现迁入独立的 `@likego/struct@0.0.1`，并保留 Go struct 的零值、未知字段忽略、alias 和显式业务校验语义。

**Architecture:** `@likego/struct` 是无生产依赖、非驻留、可移植的叶子包，不依赖 Core、Context、Transport 或 Zen Kit。第一阶段只迁移 struct 声明、运行时解析/编码及现有 codec，不接入尚未实现的 Contract/Server。

**Tech Stack:** TypeScript 7、标准 Web API、Bun Test、tsdown、oxfmt。

## Global Constraints

- 直接在用户指定的真实 `main` 工作区实施，不创建 worktree 或 feature branch。
- 不提交、推送、发布，也不覆盖当前工作区已有改动。
- 来源固定为 Zen Kit HEAD `598c218` 下无未提交改动的 `packages/core/src/struct`。
- 保留 MIT 许可证与来源说明。
- 包版本固定为 `0.0.1`，包名固定为 `@likego/struct`。
- 生产代码仅使用 ECMAScript 与标准 Web API；不增加生产依赖。
- Go struct 语义固定为：未知字段忽略、缺失字段取零值、optional/nullish 显式声明、alias 只影响 wire name、业务规则由应用负责。

---

### Task 1: 锁定公开包契约与 Go struct 行为

**Files:**
- Create: `packages/struct/test/package-contract.test.ts`
- Create: `packages/struct/test/go-struct.test.ts`

**Interfaces:**
- Consumes: LikeGo package shell conventions。
- Produces: `struct`、`StructError`、`setErrorMap` 运行时导出，以及 `Infer` 等类型导出。

- [ ] **Step 1: 写包契约失败测试**

测试必须读取 `package.json`、`capability.json`、`owner.json`，断言包名、`0.0.1`、无 dependencies、portable/non-resident 能力和精确源文件清单。

- [ ] **Step 2: 写 Go struct 语义失败测试**

```ts
const User = struct.object({
  id: struct.string(),
  pageSize: struct.number().alias("page_size"),
  nickname: struct.string().optional()
})

expect(parse(User, { id: "u_1", extra: true })).toEqual({
  id: "u_1",
  pageSize: 0
})
```

测试同时锁定类型不匹配产生 `StructError`、未知字段忽略和 alias JSON 编解码。

- [ ] **Step 3: 运行测试确认 RED**

Run: `bun test packages/struct/test/package-contract.test.ts packages/struct/test/go-struct.test.ts`

Expected: 因 `@likego/struct` 包与源码尚不存在而失败。

### Task 2: 迁移并最小适配独立包

**Files:**
- Create: `packages/struct/package.json`
- Create: `packages/struct/capability.json`
- Create: `packages/struct/owner.json`
- Create: `packages/struct/LICENSE`
- Create: `packages/struct/README.md`
- Create: `packages/struct/bunfig.toml`
- Create: `packages/struct/tsconfig.json`
- Create: `packages/struct/tsconfig.test.json`
- Create: `packages/struct/src/**`
- Create: `packages/struct/test/public-types.ts`
- Create: `packages/struct/test/coverage-contract.ts`

**Interfaces:**
- Consumes: 标准 Web API。
- Produces: 独立的 `@likego/struct` 包。

- [ ] **Step 1: 机械迁移生产源码**

复制 Zen Kit `packages/core/src/struct` 的生产文件，保留行为；把 `ExcludeUnion` 与 request value 类型移入包内，消除两个 `../internal` 依赖。所有格式由 oxfmt 统一，不做顺手重构。

- [ ] **Step 2: 建立 LikeGo 包壳**

`package.json` 使用 `0.0.1`、`sideEffects:false`、dist exports、无 dependencies；capability 声明 Bun、Node LTS/current、Deno portable non-resident；owner resources 为空。

- [ ] **Step 3: 让 RED 测试转 GREEN**

Run: `bun test packages/struct/test/package-contract.test.ts packages/struct/test/go-struct.test.ts`

Expected: PASS。

- [ ] **Step 4: 迁移原始 struct 测试并改为 Bun Test**

保留构造器、解析、编码、alias、union、security 与 codec 行为覆盖；只做 `vitest` 到 `bun:test` 的机械 import 替换。

- [ ] **Step 5: 执行包级门禁**

```sh
bun run --cwd packages/struct test
bun run --cwd packages/struct typecheck
bun run --cwd packages/struct build
bun run --cwd packages/struct test:coverage
```

Expected: 全部退出 0，line/function coverage 满足 LikeGo 100% 契约。

- [ ] **Step 6: 执行相关工作区门禁**

```sh
bun run fmt
bun run fmt:check
bun run typecheck
bun run build
bun run manifests:check
bun run file-inventory:check
```

Expected: 全部退出 0；若 file inventory 需要刷新，只运行仓库既有生成命令，不手写清单。
