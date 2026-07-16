# ADR 0002: Build, runtime matrix, and coverage

日期：2026-07-17

状态：Accepted

## Context

LikeGo 使用 Bun 开发和单元测试，但 portable packages 要被 Node、Deno、Bun 消费。直接发布 TypeScript
源码或把 workspace dependency bundle 进下游会破坏 npm 消费体验，并可能复制 Context sentinel。
Bun `1.3.14` 的 coverage 只输出 line/function counters，且未加载文件不会进入分母。

## Decision

1. Bun `1.3.14` 是 package manager、script runner 和 unit test runner；提交 `bun.lock`，CI 首步 `bun ci`。
2. npm TypeScript `7.0.2` 是 declaration/typecheck 权威；Deno 内嵌 compiler check 是额外兼容门。
3. 每个 publishable workspace emit independent ESM `dist/*.js + dist/*.d.ts`；package exports 只指向 dist。
4. workspace dependencies 保持 external；禁止 bundle `@likego/context`，跨包 sentinel identity 必须通过。
5. production source 内部相对 import 使用 `.js` specifier并由 TypeScript NodeNext 解析回 `.ts`。
6. Bun unit coverage 按 package 强制 100% lines/functions，并生成 LCOV；source inventory 将每个
   `packages/*/src/**/*.ts` 与 LCOV `SF` 对照，未加载文件直接失败。
7. Bun `1.3.14` 不生成 branch counters，`branches=1.0` 也不能作为有效 gate；Bun evidence 固定记录
   `branches:{supported:false,percent:null,reason:"BUN_1_3_14_NO_BRANCH_COUNTER"}`。published-JS numeric
   branch authority 是 Node `24.18.0`、Node `26.5.0` 与 Deno `2.9.3` 的 native coverage，不使用 `c8` 或
   其他 supplemental branch instrumenter。该 native branch gate 失败时不得宣称“100% coverage”。
8. shared behavior cases 对 build output 运行于 Node LTS/current、Deno exact、Bun exact；runner adapter
   使用各自 native test API，production code不得出现 runtime conditionals。

机器可审计 coverage contract marker：`LIKEGO_PUBLISHED_JS_BRANCH_AUTHORITY_V1`。

## Coverage exclusions

允许排除：`.d.ts`、generated schema code、test files，以及只有静态 re-export 且没有 runtime branch 的
root barrel。每一条排除必须出现在 coverage policy allowlist并由 source inventory校验；不能用 glob
排除普通 production implementation。

## Consequences

- `bun test --coverage` 通过本身不足以证明 100%；必须同时通过 source inventory 和 published-JS native branch gate。
- 单元覆盖、跨 runtime behavior、type exports、fault/recovery 和 E2E 是并列门，不能互相替代。
- 构建和 smoke tests 必须从 package name 的 dist exports 加载，不能只测试相对 src import。
