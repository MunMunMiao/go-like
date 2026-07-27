# Changesets

46 个公共包的版本变更使用 Changesets 记录。运行 `bun run changeset` 新增变更说明，运行
`bun run version:packages` 应用版本、通过官方 changelog 生成器更新包级 `CHANGELOG.md`，并执行
`bun update --filter '*'` 将新版本和内部依赖写回 `bun.lock`。根包、内部 `@likego/testing` 与 44 个私有
example 不参与 Changesets 版本管理。Changesets 不会自动提交；版本文件、变更日志和锁文件必须经审查后一起提交。

0.0.1 首发是一次性例外：首发实现 Changeset 已归档到 [`docs/releases/0.0.1/changesets`](../docs/releases/0.0.1/changesets/)，
首次发布前不要运行 `bun run version:packages`，否则会把已包含在 0.0.1 中的实现再次计入后续版本。完成全部门禁后
直接运行 `bun run release`。PR Changeset 门禁只在全部公共包仍为 `0.0.1` 且不存在任何公共包发布 tag 时豁免首发；
Changesets 发布成功后会创建 annotated `@likego/<package>@0.0.1` tags，必须运行 `git push --follow-tags` 将它们
推送到 origin，后续 PR 才会恢复上述标准流程。

首发后的 PR 只有修改公共包的 `src/**`、`package.json` 或 `LICENSE` 时才必须携带 Changeset。包级测试、README、
内部 `@likego/testing` 和私有 example 不触发该门禁。`bun run release` 的第一步会拒绝包含 tracked/untracked
改动的工作树，也会拒绝仍有未被 `bun run version:packages` 消费的 active Changeset；版本文件、锁文件和
CHANGELOG 必须先完成审查并提交。

公共包之间的生产依赖使用精确版本，私有 example 与公共包的开发依赖可使用 `workspace:*`。因此修改
`@likego/context` 或其他底层公共包时，Changesets 可能按 patch 规则同步提升直接或间接依赖包；这是为了让
发布图保持精确且可安装的预期行为。仓库不使用 `fixed` 或 `linked` 版本组。

唯一受支持的发布入口是 `bun run release`。它先检查 clean tree 与已消费的 Changeset，再执行全新构建、
`dist` 验证、私有 example 构建和构建印章，再由 Changesets 根据源码 manifest 的版本和 tag 决策发布。
46 个源码 manifest 的 `publishConfig.directory`
统一指向 `dist`，因此真正交给 npm 的是已验证的扁平 `dist` 包；生成后的 `dist/package.json` 只保留
`publishConfig.access: "public"`，不再递归指向自身。禁止直接运行裸 `changeset publish`，否则会绕过本仓库的
全新构建、验证和印章门禁。
