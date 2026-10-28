# File Store 与外部重启：对照实验与归因

研究日期：2026-08-26。产品验证快照为 `5bf7faee8926bd9664fcb8d9f41a2b61e6937dae`，范围是 File Store 生命周期、MS-011 消费者及 MS-016/MS-017 故障判定。以下保存原报告的研究结论与限制，本次没有重跑实验。

## 结论与归因方法

四组产品合同实验及 205 项聚焦测试通过。MS-011 的等待器把 failed 状态继续轮询成通用超时；MS-016/MS-017 的旧判定缺少容器终态和重启身份，单凭 HTTP 失败不能归因于库恢复能力。

同环境、同阶段的 go-like 失败和可信对照通过，只能形成产品缺陷候选，还需要最小复现。双侧失败、对照实现单侧失败、探活客户端失败和证据不完整，都不能直接扩大产品 API。历史原始证据保持冻结，新的观察单独记录。

## 第三方成熟框架调研与采用结论

### 生命周期、就绪与关闭

调研对象：

- [Fastify Server lifecycle](https://fastify.dev/docs/latest/Reference/Server/)
- [NestJS Lifecycle events](https://docs.nestjs.com/fundamentals/lifecycle-events)
- [NestJS Terminus / Health checks](https://docs.nestjs.com/recipes/terminus)
- [Moleculer Service lifecycle](https://moleculer.services/docs/0.15/lifecycle)

这些框架的共同做法是分开处理“生命周期”“是否对外接流量”“业务就绪”和“关闭排空”。关闭后的实例通常不是一个隐含的可复用重启原语；需要恢复时，应创建新进程、新实例或由外部编排器重新启动。

**采用结论：** 当时的 go-like 一次性 resident 生命周期没有被这些实验推翻。需要修的是消费者等待终态的逻辑，以及 harness 对外部重启过程的取证顺序。

### 文件存储与锁所有权

调研对象：

- Level 风格存储的 opening / open / closing / closed 状态模型
- [`proper-lockfile`](https://github.com/moxystudio/node-proper-lockfile) 的显式 release 与 stale lock 机制

显式持有与释放所有权值得保留，但自动 stale reclaim 会改变 原快照的 go-like“无法证明锁已失效就拒绝接管”的 fail-closed 安全合同。

**采用结论：** 不引入自动过期接管，也不新增锁抽象。MS-011 只修终态判断和错误传播。

### 重试与恢复策略

调研对象：

- [KafkaJS retry and restart configuration](https://kafka.js.org/docs/2.0.0/configuration)

成熟实现会把协议操作重试与服务进程重启分开。重试次数、退避和是否重启依赖具体消费者和协议，不适合塞入 Core 的统一配置。

**采用结论：** `waitForStore` 只理解 File Store 已公开的状态；容器重启证据由 MS-016 / MS-017 harness 负责；不增加全局 recovery budget。

### 包闭包与 Docker 镜像

调研对象：

- [`npm pack`](https://docs.npmjs.com/cli/v7/commands/npm-pack/) 的包产物边界
- [`docker image rm`](https://docs.docker.com/reference/cli/docker/image/rm/) 的精确删除语义
- [`docker image ls`](https://docs.docker.com/reference/cli/docker/image/ls/) 与 [`docker image prune`](https://docs.docker.com/reference/cli/docker/image/prune/) 的作用范围

包闭包应依据冻结 manifest、锁文件和 vendor 哈希验证；镜像清理应依据创建时记录的精确 ID/tag，并在同一 daemon 上 inspect、remove、readback。prune 会扩大删除范围，不适合证据战役。

**采用结论：** 复用现有 manifest/hash 校验和 Docker CLI；不自建依赖解析器，不使用 prune，不允许按名称猜测所有权。

## 实验与根因

### File Store 合同实验（原快照）

在真实临时目录上执行四组控制：

| 实验                    | 观察                                                                              | 结论                         |
| ----------------------- | --------------------------------------------------------------------------------- | ---------------------------- |
| 正常生命周期            | `start()` 在运行期间保持 pending；状态进入 running 后读写成功；`stop()` 后可 join | resident promise 符合合同    |
| acquire 注入失败        | 观察者拿到同一个 sentinel 错误，状态为 failed                                     | 原始启动错误没有被产品层吞掉 |
| acquire 长时间 pending  | 外层等待超时不会伪造底层取消；释放 acquire 后可正常 stop/join                     | 不应给产品层增加虚假取消语义 |
| Node `fs/promises` 对照 | 相同环境期限内目录、写、读、删均成功                                              | 不是文件系统环境普遍阻塞     |

因此，历史 MS-011 的 `file store did not become running` 不是该快照上 `@go-like/store-file` 的已证实缺陷。

### MS-011：消费者覆盖了终态错误

根因位于消费者共享 `waitForStore`：旧逻辑在读到 `failed` 后仍进行固定次数轮询，最终只抛出通用 timeout，既延迟失败，又丢掉实际 cause。

修复后的行为：

- 只有 `starting` 可以重试。
- `running` 立即通过。
- 其他终态立即抛错，错误链带上状态和底层 cause。
- Context 取消后停止后续状态读取。
- 不再依赖原来的 `200 × 5ms` 魔法上限。

验证覆盖了正常就绪、超过旧重试上限仍可继续、终态立即失败、Context 取消和旧锁 fail-closed。

### MS-016 / MS-017：HTTP 超时不能证明重启失败

旧 fault oracle 直接执行 kill/start 后等待 HTTP。若 kill 尚未完成、启动命令作用于错误对象、容器身份漂移或进程已经以非零码退出，最终都会被压成同一种 `ECONNREFUSED`。

修复后的顺序：

1. 用 compose project、run、role 等标签解析唯一容器 ID。
2. 等待该精确 ID 进入终态，记录 exit code、`StartedAt`、`FinishedAt` 和日志尾部。
3. 只删除该 run 的规范 marker 文件，并验证普通文件、链接数和父目录边界。
4. 对同一 compose 对象执行 start。
5. 再次 inspect，要求容器 ID 不变、状态为 running、`StartedAt` 已更新。
6. 最后才等待 `/livez`。

真实 Docker 实验结果：

- MS-016 graceful SIGTERM：同一容器 ID 终态后重新运行，`/livez` 恢复。
- MS-016 forced SIGKILL：同一容器 ID 以 137 退出后重新运行，`/livez` 恢复。
- MS-017 gateway graceful SIGTERM：容器退出码为 1；确认终态后，同一容器重新启动并恢复 `/livez`。
- MS-017 构建镜像：镜像以实验专用标签和精确 ID 绑定到对应运行；无 RepoDigest，所有权标签与 Compose 对齐。
- 实验结束后，精确镜像 readback 不存在；带 run 标签的容器、网络、卷均为 0；临时目录不存在；实验使用的端口空闲。

结论是历史失败主要来自不完整的故障取证，而不能据此确认该快照上 `@go-like/web` 存在重启缺陷。

## 验证结果

| 范围                           | 命令/类型                                                 | 结果                      |
| ------------------------------ | --------------------------------------------------------- | ------------------------- |
| go-like 产品合同               | Core / Health / Server / Store File / Resilience 聚焦测试 | 205 通过，0 失败          |
| 中央 harness 受影响测试        | build + bundle/cleanup/evidence/gates                     | 156 通过，0 失败          |
| 中央 harness 全量测试          | `npm test`                                                | 275 项中 273 通过，2 失败 |
| 中央 preflight 独立审查        | preflight 聚焦测试                                        | 5 通过，0 失败            |
| MS-011 项目的 go-like consumer | `npm test`                                                | 12 通过，0 失败           |
| MS-011 项目 harness            | `npm test`                                                | 44 通过，0 失败           |
| MS-016 项目 harness            | `npm test`                                                | 42 通过，0 失败           |
| MS-017 项目 harness            | `npm test`                                                | 37 通过，0 失败           |
| 真实 Docker                    | MS-016/017 kill → terminal → start → live + 精确 cleanup  | 通过                      |

中央 harness 全量测试的 2 个失败都在 `staging.test`：隔离 producer checkout 的 HEAD 为 `5bf7fae…`，而测试 fixture 固定要求历史 `cd15313…`，并且在预期的 pack 注入点之前失败。这是测试前置版本不匹配，未构成被测功能路径失败的证据；因此本报告不宣称全量测试全部通过。

## 原报告仍未关闭的证据缺口

- **MS-013 / MS-018**：历史两侧都失败，且失败点并不相同。没有新通过对照，不应改 go-like。
- **完整 campaign**：原报告完成了真实组件和 Docker 对照，但未执行新的完整四车道 campaign。因此不能从局部通过推断全部项目通过。
- **历史证书**：旧 dest 的 cleanup 流程或 producer SHA 不满足后续门禁，原报告未为它们补发通过证书。
- **复杂 YAML**：preflight 故意只接受当前项目使用的普通、单引号和双引号 image scalar，不支持 anchors、folded 或 multiline image。出现真实项目需求时再扩展；目前引入通用 YAML 解析器没有证据收益。
- **staging fixture**：两项测试的冻结基准与实验快照不匹配；原报告没有通过改变历史基准掩盖失败。
