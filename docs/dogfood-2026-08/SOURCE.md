# 原始产物来源

本目录是收获快照，不是战役工作区。原始 artifacts、findings JSON、UX JSON、verify JSON 与 journal 仍留在 `go-like-dogfood`。后续生产者工作应对照那些路径，而不是把本目录当作可再跑的 dest。

战役根目录：

```
/Users/munmunmiao/Documents/web/go-like-dogfood/campaigns
```

项目路径模式：

```
{campaigns}/2026-08-microservices-{dest}/projects/{projectId}/
```

相对路径（findings 行里的 `evidencePaths`）均相对于对应 `projects/{projectId}/`。

## 本快照复制了什么

只写入 `docs/dogfood-2026-08/` 下的索引与综述。不复制：

- `artifacts/run-*/stdout` 与 `stderr`
- `findings/*.json` 原文（字段已抽到 `findings-index.json`）
- `ux/golike.json` 与 `ux/competitor.json` 原文
- Compose 文件、镜像、volume、网络
- LikeGo `packages/`、`examples/`、`e2e/`、`doc/` 指南

## 已接纳 dest（含 verify）

共 21 条。每条都有 `verify-{projectId}.json`，以及 `ux/competitor.json` 与 `ux/golike.json`。

| projectId | dest    | destNumber | assertionsPassed | findings | verifyPath                                                                                                                   |
| --------- | ------- | ---------: | ---------------- | -------: | ---------------------------------------------------------------------------------------------------------------------------- |
| MS-001    | fw-r154 |        154 | true             |        0 | `/Users/munmunmiao/Documents/web/go-like-dogfood/campaigns/2026-08-microservices-fw-r154/projects/MS-001/verify-MS-001.json` |
| MS-002    | fw-r192 |        192 | true             |        0 | `/Users/munmunmiao/Documents/web/go-like-dogfood/campaigns/2026-08-microservices-fw-r192/projects/MS-002/verify-MS-002.json` |
| MS-003    | fw-r143 |        143 | true             |        0 | `/Users/munmunmiao/Documents/web/go-like-dogfood/campaigns/2026-08-microservices-fw-r143/projects/MS-003/verify-MS-003.json` |
| MS-004    | fw-r199 |        199 | true             |        0 | `/Users/munmunmiao/Documents/web/go-like-dogfood/campaigns/2026-08-microservices-fw-r199/projects/MS-004/verify-MS-004.json` |
| MS-005    | fw-r175 |        175 | true             |        0 | `/Users/munmunmiao/Documents/web/go-like-dogfood/campaigns/2026-08-microservices-fw-r175/projects/MS-005/verify-MS-005.json` |
| MS-006    | fw-r214 |        214 | false            |        6 | `/Users/munmunmiao/Documents/web/go-like-dogfood/campaigns/2026-08-microservices-fw-r214/projects/MS-006/verify-MS-006.json` |
| MS-007    | fw-r218 |        218 | true             |        0 | `/Users/munmunmiao/Documents/web/go-like-dogfood/campaigns/2026-08-microservices-fw-r218/projects/MS-007/verify-MS-007.json` |
| MS-008    | fw-r226 |        226 | true             |        0 | `/Users/munmunmiao/Documents/web/go-like-dogfood/campaigns/2026-08-microservices-fw-r226/projects/MS-008/verify-MS-008.json` |
| MS-009    | fw-r230 |        230 | false            |        6 | `/Users/munmunmiao/Documents/web/go-like-dogfood/campaigns/2026-08-microservices-fw-r230/projects/MS-009/verify-MS-009.json` |
| MS-010    | fw-r231 |        231 | false            |        6 | `/Users/munmunmiao/Documents/web/go-like-dogfood/campaigns/2026-08-microservices-fw-r231/projects/MS-010/verify-MS-010.json` |
| MS-011    | fw-r234 |        234 | false            |       12 | `/Users/munmunmiao/Documents/web/go-like-dogfood/campaigns/2026-08-microservices-fw-r234/projects/MS-011/verify-MS-011.json` |
| MS-012    | fw-r236 |        236 | true             |        0 | `/Users/munmunmiao/Documents/web/go-like-dogfood/campaigns/2026-08-microservices-fw-r236/projects/MS-012/verify-MS-012.json` |
| MS-013    | fw-r239 |        239 | false            |       12 | `/Users/munmunmiao/Documents/web/go-like-dogfood/campaigns/2026-08-microservices-fw-r239/projects/MS-013/verify-MS-013.json` |
| MS-014    | fw-r240 |        240 | true             |        0 | `/Users/munmunmiao/Documents/web/go-like-dogfood/campaigns/2026-08-microservices-fw-r240/projects/MS-014/verify-MS-014.json` |
| MS-015    | fw-r241 |        241 | true             |        0 | `/Users/munmunmiao/Documents/web/go-like-dogfood/campaigns/2026-08-microservices-fw-r241/projects/MS-015/verify-MS-015.json` |
| MS-016    | fw-r244 |        244 | false            |       12 | `/Users/munmunmiao/Documents/web/go-like-dogfood/campaigns/2026-08-microservices-fw-r244/projects/MS-016/verify-MS-016.json` |
| MS-017    | fw-r245 |        245 | false            |       12 | `/Users/munmunmiao/Documents/web/go-like-dogfood/campaigns/2026-08-microservices-fw-r245/projects/MS-017/verify-MS-017.json` |
| MS-018    | fw-r247 |        247 | false            |       12 | `/Users/munmunmiao/Documents/web/go-like-dogfood/campaigns/2026-08-microservices-fw-r247/projects/MS-018/verify-MS-018.json` |
| MS-020    | fw-r183 |        183 | false            |        6 | `/Users/munmunmiao/Documents/web/go-like-dogfood/campaigns/2026-08-microservices-fw-r183/projects/MS-020/verify-MS-020.json` |
| MS-025    | fw-r134 |        134 | true             |        0 | `/Users/munmunmiao/Documents/web/go-like-dogfood/campaigns/2026-08-microservices-fw-r134/projects/MS-025/verify-MS-025.json` |
| MS-027    | fw-r186 |        186 | true             |        0 | `/Users/munmunmiao/Documents/web/go-like-dogfood/campaigns/2026-08-microservices-fw-r186/projects/MS-027/verify-MS-027.json` |

findings 目录只出现在 `assertionsPassed=false` 的 dest 上，计数为 `6/6/6/12/12/12/12/12/6`，分别对应 `MS-006`、`MS-009`、`MS-010`、`MS-011`、`MS-013`、`MS-016`、`MS-017`、`MS-018`、`MS-020`。

## first-wave dest（无 verify）

共 4 条。每条有 `project-cleanup.json`（`passed=true`）、`ux/competitor.json` 与 `ux/golike.json`，没有 `verify-*.json`，没有 `findings/`。

| projectId | dest    | destNumber | projectCleanupPath                                                                                                             |
| --------- | ------- | ---------: | ------------------------------------------------------------------------------------------------------------------------------ |
| MS-022    | fw-r25  |         25 | `/Users/munmunmiao/Documents/web/go-like-dogfood/campaigns/2026-08-microservices-fw-r25/projects/MS-022/project-cleanup.json`  |
| MS-033    | fw-r73  |         73 | `/Users/munmunmiao/Documents/web/go-like-dogfood/campaigns/2026-08-microservices-fw-r73/projects/MS-033/project-cleanup.json`  |
| MS-037    | fw-r109 |        109 | `/Users/munmunmiao/Documents/web/go-like-dogfood/campaigns/2026-08-microservices-fw-r109/projects/MS-037/project-cleanup.json` |
| MS-039    | fw-r12  |         12 | `/Users/munmunmiao/Documents/web/go-like-dogfood/campaigns/2026-08-microservices-fw-r12/projects/MS-039/project-cleanup.json`  |

first-wave 的 UX 文件存在于上述 dest，但本快照的 `ux-summary.md` 行集来自 21 条含 verify 的已接纳 dest，不含这四条。

## 未启动

下列 15 个 ID 没有 `2026-08-microservices-fw-r*` dest，因此本目录没有对应路径：

`MS-019`、`MS-021`、`MS-023`、`MS-024`、`MS-026`、`MS-028`、`MS-029`、`MS-030`、`MS-031`、`MS-032`、`MS-034`、`MS-035`、`MS-036`、`MS-038`、`MS-040`。

## 工作区 UX

`/Users/munmunmiao/Documents/web/likego/ux/golike.json` 与 `competitor.json` 不存在。UX 证据以各 dest 的 `projects/*/ux/` 为准。
