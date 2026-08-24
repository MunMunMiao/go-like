# 2026-08 微服务 dogfood 收获快照

本目录是从 `go-like-dogfood` 战役产物中收获的只读快照，供 `likego` 生产者在 SHA `cd15313d` 上规划下一轮库工作。原始 run 日志、Compose 状态、镜像和 findings JSON 仍留在 dogfood 仓库；此处不替代那些文件。

## 战役目的

在固定生产者提交上，对微服务样本（`MS-001` … `MS-040`）同时跑 go-like 与 competitor 两条实现，并覆盖 `local-go-like`、`docker-go-like`、`local-competitor`、`docker-competitor` 四条车道。目标是把**有 dest 证据**的能力缺口、应用误用和对照失败从战役目录里抽出来，而不是在 `packages/` 里直接改代码。

判定约定：

- 仅当 go-like 失败且同一 dest 上 competitor 通过时，才把 `suspectedOwner` 为 `go-like` 的项视为可提升的库问题。
- 双失败 dest（两条实现都未通过同一产品阶段）**不得**提升为库缺陷。
- `suspectedOwner` 为 `application` 或 `competitor` 的项记录在目录中，但不进入库修复队列，除非后续有对照 dest 把它从双失败中隔离出来。

## 生产者版本

| 项       | 值                                                             |
| -------- | -------------------------------------------------------------- |
| 短 SHA   | `cd15313d`                                                     |
| 完整 SHA | `cd15313d50e6804cfe34a7e7291cb65a861dec1c`                     |
| 分支     | `main`（packed-refs；工作区 `.git/refs/heads` 为空）           |
| 等价命令 | `git -C /Users/munmunmiao/Documents/web/likego rev-parse HEAD` |

收获当时未改 `packages/`。其后 P0 已在 `a6d2667` / `43abe749` 落地；关闭 dest 与「以后如何跑完 40 个」见 [dest-learn-report.md](dest-learn-report.md) 与 [RESUME.md](RESUME.md)。

## 规模

| 类别        | 数量 | 说明                                                                       |
| ----------- | ---: | -------------------------------------------------------------------------- |
| 计划项目    |   40 | `MS-001` … `MS-040`                                                        |
| 已接纳      |   25 | 21 条含 `verify-MS-*.json`，另 4 条 first-wave 仅有 `project-cleanup.json` |
| 未启动      |   15 | 无 campaign dest、无 verify、无 findings                                   |
| verify 通过 |   12 | `assertionsPassed=true`，`findingsFileCount=0`                             |
| verify 失败 |    9 | `assertionsPassed=false`，共 84 条 findings JSON                           |
| first-wave  |    4 | 清理通过，无 `verify-*.json`，无 findings                                  |

21 条含 verify 的已接纳 dest 均满足：`evidenceComplete=true`、`cleanupPassed=true`、四条车道 `admittedRepetitions` 均为 `[1,2,3]`，且同时存在 `ux/competitor.json` 与 `ux/golike.json`。

## 本目录文件

| 文件                                         | 内容                                                      |
| -------------------------------------------- | --------------------------------------------------------- |
| [SOURCE.md](SOURCE.md)                       | dest 路径映射；声明原始产物仍在 `go-like-dogfood`         |
| [inventory.json](inventory.json)             | 已接纳 / first-wave / 未启动 的机器可读清单               |
| [findings-index.json](findings-index.json)   | 84 条 finding 行（JSON 数组）                             |
| [findings-catalog.md](findings-catalog.md)   | 按 `suspectedOwner` 再按 `package` 分组，并标注 dest 分类 |
| [ux-summary.md](ux-summary.md)               | 从 UX 行归纳的重复 DX 摩擦                                |
| [next-work.md](next-work.md)                 | 生产者 backlog：仅含有 dest 证据的项；文首标明 P0 已落地  |
| [dest-learn-report.md](dest-learn-report.md) | 关闭 dest 学习结论：无新的可提升库缺口                    |
| [RESUME.md](RESUME.md)                       | 以后跑完 40 个项目的续跑说明                              |

阅读顺序：本文件 → `RESUME.md` → `dest-learn-report.md` → `SOURCE.md` → `findings-catalog.md` 与 `ux-summary.md` → `next-work.md`。需要核对原始字段时再用两个 JSON。
