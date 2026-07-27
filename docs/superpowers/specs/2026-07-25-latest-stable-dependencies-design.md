# LikeGo 最新正式版依赖升级设计

日期：2026-07-25

## 目标

把仓库直接维护的 npm 依赖、运行时版本、GitHub Actions 与 Docker 镜像升级到各自最新正式版，并保持现有公共 API、生命周期语义和验证门禁不变。

## 版本规则

- 正式版不包含 `alpha`、`beta`、`rc`、`canary`、`nightly` 等预发布版本。
- npm 依赖优先采用官方 registry 的非预发布、非废弃 `dist-tags.latest`；仅当 `latest` 指向预发布版时，才按发布时间回退到最近发布的非预发布、非废弃版本。内部 `@likego/*` 包继续保持 `0.0.1`。该规则既避免把维护分支的较晚发布日期误判为主线最新版本，也避免 H3 的 RC `latest` 被当成正式版。
- Node 同时保留最新 LTS 与最新 Current 两条运行时通道；Bun、Deno 使用最新正式版。
- Docker 使用上游最新正式版标签，并固定当前多架构 manifest digest；GitHub Actions 固定正式 release commit SHA。
- 上游依赖自身的传递依赖不越过其声明范围强制覆盖。

Pino `10.3.1` 当前声明 `sonic-boom ^4.0.1`。`@likego/pino` 不再把 SonicBoom 暴露为直接依赖或 peer；由 Pino 解析其受支持的传递版本，消费应用可以独立安装最新正式版 SonicBoom，而不会形成双重版本约束。

## 实施方式

使用 Bun workspace 的递归升级能力统一更新 manifest 与 lockfile。若 major 升级破坏现有适配，只在真实调用边界做最小兼容修复并保留回归测试；不新增依赖升级框架或兼容抽象。

## 验证

升级后要求官方 registry 按上述 `dist-tags.latest` 与预发布回退规则审计，不再报告可升级的直接依赖。`bun outdated --recursive` 仍可能把 H3 的 `2.0.1-rc.26` 列为 `Latest`，该预发布提示不视为正式版落后。随后依次通过格式、lint/仓库规则、类型检查、单元测试、构建、发布包安装测试、示例和真实 Docker 集成测试，最后回读 Docker 残留与工作区差异。
