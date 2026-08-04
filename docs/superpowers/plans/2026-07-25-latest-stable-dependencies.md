# go-like 最新正式版依赖升级实施计划

日期：2026-07-25

1. 盘点所有 workspace manifest、runtime matrix、Actions 和 Docker 镜像，并用官方来源确认最新正式版。
2. 先更新版本契约测试，使旧版本在针对性测试中失败。
3. 使用 `bun update --latest --recursive` 更新 npm workspace；对 latest dist-tag 指向预发布版的包，按官方 registry 发布时间显式选择最近发布的非预发布、非废弃版本。
4. 更新 runtime、Actions、Docker 标签与 digest，并同步唯一事实来源及其契约测试。
5. 对升级暴露的 API 或运行时变化做最小修复，先跑针对性测试，再跑真实 Docker 测试。
6. 运行 `bun run verify`、正式版 registry 审计、`bun outdated --recursive`、`git diff --check` 和 Docker 零残留回读；单独解释 H3 的 RC dist-tag 提示。
