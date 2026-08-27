# 40 个微服务项目后的 go-like 与证据链整改报告

**日期：** 2026-08-26

**范围：** go-like 验证快照 `5bf7faee` 的产品合同、40 项目 dogfood 证据框架、MS-011 / MS-016 / MS-017 消费者与故障实验

**状态：** dogfood harness 与消费者修复已在各自隔离工作区完成并通过聚焦验证；仍未提交、合并、发布或写回历史 campaign

## 一、结论摘要

本轮没有修改 go-like 产品包。针对验证快照 `5bf7faee` 中的 `@go-like/store-file`、Core、Health、Server 和 Resilience，205 项聚焦测试及四组真实合同实验均通过。历史 MS-011 的现象不是 File Store 生命周期缺陷，而是消费者把终态失败继续轮询，最后将原始错误覆盖成通用超时。

确认并修复了五类实际问题：

1. **MS-011 消费者等待逻辑错误**：现在只对 `starting` 重试；遇到 `failed`、`stopped` 等终态立即失败并保留原始原因；Context 取消后不再继续读状态。
2. **MS-016 / MS-017 故障恢复判定错误**：原逻辑只看 HTTP，无法区分“容器没有真正退出或重启”和“应用重启后没有恢复”。现在先证明同一容器 ID 进入终态，再精确删除状态标记、启动同一容器，并核对新 `StartedAt`、运行状态和 `/livez`。
3. **UX 零命令证据含义不清**：`commandCount: 0` 必须显式声明 `observation: "unobserved"`；已观察记录不能再用零命令冒充完整观察。
4. **最终项目门禁没有独立、不可变证书**：新完成的项目会在清理通过后生成确定性的 `verify-<project>.json`，绑定 producer SHA、门禁结果和实际输入哈希；拒绝符号链接、畸形或冲突证书，并覆盖了文件替换竞态。
5. **Docker 镜像所有权和预检不够严格**：运行记录现在可登记精确镜像 ID 与唯一 tag；清理只删除本 run 的精确 tag，禁止 `--force` 和 prune，并独立读回镜像消失。新增只读 `preflight-project`，在创建容器、进程、端口或证据目录前检查 Git、锁文件、vendor 闭包及 Compose / Dockerfile 镜像引用。

MS-013 和 MS-018 仍属于历史双侧失败，当前没有足够的通过对照把问题归到 go-like。它们没有被伪装成“已修复”，也没有因此增加产品 API。

## 二、判断依据与边界

### 2.1 缺陷归属规则

40 项目实践暴露出的最大风险不是“缺功能”，而是把不同层次的失败混在一起。此次继续沿用并强化以下规则：

| 证据形态                               | 允许的结论                             | 本轮处理                                    |
| -------------------------------------- | -------------------------------------- | ------------------------------------------- |
| go-like 失败、同环境可信对照通过       | 可提升为产品缺陷候选                   | 先做当前版本最小复现，再决定是否改产品      |
| go-like 与 competitor 同阶段都失败     | 只能说明 dest、应用或 harness 尚未隔离 | 不修改产品 API                              |
| 产品合同实验通过，消费者失败           | 消费者误用或等待策略错误               | 修消费者公共路径                            |
| HTTP 恢复失败，但没有进程/容器身份证据 | 无法证明产品恢复失败                   | 先补终态、身份、时间戳和日志证据            |
| 资源由 run 创建但没有精确所有权记录    | 清理不可安全自动化                     | 先记录精确身份，再允许删除                  |
| 历史证据缺少新字段或最终证书           | 历史事实仍保持原样                     | 不回填、不覆盖，规则只作用于新 finalization |

### 2.2 明确未做的事项

- 没有把 `App` 或 `Server` 改成可反复启动的通用 supervisor。
- 没有给 File Store 增加 `ready(ctx)`，也没有改变 resident `start()` 的语义。
- 没有自动接管 stale lock；现有 fail-closed 单所有者合同保持不变。
- 没有新增跨协议的全局重试预算或恢复框架。
- 没有加入 YAML 解析器、包管理器解析器或 Docker 资源管理依赖。
- 没有修改、补写或重跑旧 dest 的已冻结证据。
- 没有在原始脏工作区提交、推送、发布、部署或执行广义 Docker prune。

## 三、第三方成熟框架调研与采用结论

### 3.1 生命周期、就绪与关闭

调研对象：

- [Fastify Server lifecycle](https://fastify.dev/docs/latest/Reference/Server/)
- [NestJS Lifecycle events](https://docs.nestjs.com/fundamentals/lifecycle-events)
- [NestJS Terminus / Health checks](https://docs.nestjs.com/recipes/terminus)
- [Moleculer Service lifecycle](https://moleculer.services/docs/0.15/lifecycle)

这些框架的共同做法是分开处理“生命周期”“是否对外接流量”“业务就绪”和“关闭排空”。关闭后的实例通常不是一个隐含的可复用重启原语；需要恢复时，应创建新进程、新实例或由外部编排器重新启动。

**采用结论：** go-like 当前一次性 resident 生命周期不需要重写。需要修的是消费者等待终态的逻辑，以及 harness 对外部重启过程的取证顺序。

### 3.2 文件存储与锁所有权

调研对象：

- Level 风格存储的 opening / open / closing / closed 状态模型
- [`proper-lockfile`](https://github.com/moxystudio/node-proper-lockfile) 的显式 release 与 stale lock 机制

显式持有与释放所有权值得保留，但自动 stale reclaim 会改变 go-like 当前“无法证明锁已失效就拒绝接管”的 fail-closed 安全合同。

**采用结论：** 不引入自动过期接管，也不新增锁抽象。MS-011 只修终态判断和错误传播。

### 3.3 重试与恢复策略

调研对象：

- [KafkaJS retry and restart configuration](https://kafka.js.org/docs/2.0.0/configuration)

成熟实现会把协议操作重试与服务进程重启分开。重试次数、退避和是否重启依赖具体消费者和协议，不适合塞入 Core 的统一配置。

**采用结论：** `waitForStore` 只理解 File Store 已公开的状态；容器重启证据由 MS-016 / MS-017 harness 负责；不增加全局 recovery budget。

### 3.4 包闭包与 Docker 镜像

调研对象：

- [`npm pack`](https://docs.npmjs.com/cli/v7/commands/npm-pack/) 的包产物边界
- [`docker image rm`](https://docs.docker.com/reference/cli/docker/image/rm/) 的精确删除语义
- [`docker image ls`](https://docs.docker.com/reference/cli/docker/image/ls/) 与 [`docker image prune`](https://docs.docker.com/reference/cli/docker/image/prune/) 的作用范围

包闭包应依据冻结 manifest、锁文件和 vendor 哈希验证；镜像清理应依据创建时记录的精确 ID/tag，并在同一 daemon 上 inspect、remove、readback。prune 会扩大删除范围，不适合证据战役。

**采用结论：** 复用现有 manifest/hash 校验和 Docker CLI；不自建依赖解析器，不使用 prune，不允许按名称猜测所有权。

## 四、实验与根因

### 4.1 File Store 当前合同实验

在真实临时目录上执行四组控制：

| 实验                    | 观察                                                                              | 结论                         |
| ----------------------- | --------------------------------------------------------------------------------- | ---------------------------- |
| 正常生命周期            | `start()` 在运行期间保持 pending；状态进入 running 后读写成功；`stop()` 后可 join | resident promise 符合合同    |
| acquire 注入失败        | 观察者拿到同一个 sentinel 错误，状态为 failed                                     | 原始启动错误没有被产品层吞掉 |
| acquire 长时间 pending  | 外层等待超时不会伪造底层取消；释放 acquire 后可正常 stop/join                     | 不应给产品层增加虚假取消语义 |
| Node `fs/promises` 对照 | 相同环境期限内目录、写、读、删均成功                                              | 不是文件系统环境普遍阻塞     |

因此，历史 MS-011 的 `file store did not become running` 不是当前 `@go-like/store-file` 的已证实缺陷。

### 4.2 MS-011：消费者覆盖了终态错误

根因位于消费者共享 `waitForStore`：旧逻辑在读到 `failed` 后仍进行固定次数轮询，最终只抛出通用 timeout，既延迟失败，又丢掉实际 cause。

修复后的行为：

- 只有 `starting` 可以重试。
- `running` 立即通过。
- 其他终态立即抛错，错误链带上状态和底层 cause。
- Context 取消后停止后续状态读取。
- 不再依赖原来的 `200 × 5ms` 魔法上限。

验证覆盖了正常就绪、超过旧重试上限仍可继续、终态立即失败、Context 取消和旧锁 fail-closed。

### 4.3 MS-016 / MS-017：HTTP 超时不能证明重启失败

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
- MS-017 gateway graceful SIGTERM：容器 `bf7a2094…87973` 退出码 1，`FinishedAt` 为 06:18:13Z；同一 ID 在 06:18:14Z 重新启动并恢复 `/livez`。
- MS-017 构建镜像：唯一 tag `ms017-lnc:run-01700000-0000-4000-8000-000000000026`，ID `sha256:f753616a…e5ce64`，无 RepoDigest，标签与 run/compose 对齐。
- 实验结束后，精确镜像 readback 不存在；带 run 标签的容器、网络、卷均为 0；临时目录不存在；41720–41725 端口空闲。

结论是历史失败主要来自不完整的故障取证，而不是 `@go-like/web` 的当前重启缺陷。

## 五、已完成的 dogfood harness/consumer 修复

### 5.1 中央 dogfood harness

隔离工作区：`/Users/munmunmiao/Documents/web/go-like-dogfood-framework-fixes`

分支：`codex/framework-evidence-fixes`

基线：`57f2aa6b78218b21eae3e3f72b876daf8afa394b`

主要修改：

| 区域                                   | 结果                                                                                |
| -------------------------------------- | ----------------------------------------------------------------------------------- |
| `src/evidence.ts` / `src/contracts.ts` | 零命令记录必须显式 unobserved，且 unobserved 不能声称非零命令                       |
| `src/gates.ts`                         | 新 finalization 生成确定性最终证书；绑定 producer、门禁与输入哈希；支持安全幂等重试 |
| `src/cleanup.ts` / `src/validation.ts` | 精确验证和删除 run-owned 镜像；拒绝 tag、ID、label、digest、ancestor 等身份冲突     |
| `src/preflight.ts`                     | 新增无副作用的 Git、锁文件、vendor 和镜像引用预检                                   |
| `src/bundle.ts`                        | bundle 捕获前要求声明的镜像集合已清空                                               |
| `src/cli.ts` / `README.md`             | 发布 `preflight-project`，更新能力说明                                              |

安全细节：

- 最终证书使用 `O_NOFOLLOW`、文件与父目录 fsync、无覆盖 hard-link 发布。
- 证书读取在文件描述符绑定后完成，测试覆盖 child-open/swap-back 文件替换竞态。
- 旧 ownership 记录不含 `images` 时保持兼容，但不会据此扫描并猜删镜像。
- 新记录有 `images` 时，未登记但带本 run 标签的镜像会使 cleanup 失败，避免资源悄悄泄漏。
- 镜像删除命令固定为 `docker image rm --no-prune <exact-tag>`；从不使用 force 或 prune。
- preflight 接受项目 manifest 中的 digest pin，或 `${IMPLEMENTATION_IMAGE:?required}`；静态 Compose 镜像必须满足冻结合同。

### 5.2 MS-011 消费者

隔离工作区：`/Users/munmunmiao/Documents/web/go-like-dogfood-ms011-framework-fix`

分支：`codex/store-readiness-fix`

基线：`7d1ed55b6967d2031d43a0ef438d7f7ad3831874`

- 修复 `implementations/go-like/src/jobs.ts` 中的 `waitForStore`。
- 为状态、终态 cause、长启动与取消增加最小回归测试。
- Docker build 统一走一个带标签的实现镜像入口，并在创建容器前完成 ownership append 与独立 readback。
- 所有构建路径复用同一 helper；没有保留 compose build 的旁路。

### 5.3 MS-016 / MS-017 消费者与故障 harness

隔离工作区：

- `/Users/munmunmiao/Documents/web/go-like-dogfood-ms016-framework-fix`，分支 `codex/restart-evidence-fix`，基线 `bae1d2729b4650c184870a54bebacd42aea6ab06`
- `/Users/munmunmiao/Documents/web/go-like-dogfood-ms017-framework-fix`，分支 `codex/restart-evidence-fix`，基线 `b33e3314a6dcc6c9174d0668e10ba4da99bed043`

两者均完成：

- 终态、容器身份、exit code、时间戳和日志诊断。
- 规范 marker 的边界、普通文件和 `nlink=1` 校验。
- 同一容器 ID 重启及 `/livez` 恢复证明。
- 单一镜像构建入口、build labels、精确 inspect、ownership append/readback。
- ownership 镜像集合只能增长，防止后写记录悄悄丢失已创建资源。

## 六、验证结果

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
| 代码差异                       | 各工作区 `git diff --check`                               | 通过                      |
| 独立团队复核                   | 最终证书、三项目 image/restart、preflight                 | 全部 APPROVE              |
| 真实 Docker                    | MS-016/017 kill → terminal → start → live + 精确 cleanup  | 通过                      |

中央 harness 全量测试的 2 个失败都在 `staging.test`：隔离 producer checkout 当前 HEAD 为 `5bf7fae…`，而测试 fixture 固定要求历史 `cd15313…`，并且在预期的 pack 注入点之前失败。这是测试前置版本不匹配，不是本轮修改路径的功能失败；因此本报告不宣称全量测试全部通过。

## 七、集成顺序与当前限制

### 7.1 必须按顺序集成

1. 先将中央 harness 修复合入目标分支并重新构建 `dist`。
2. 再应用 MS-011 / MS-016 / MS-017 修复。三个项目的 `scripts/owned.mjs` 会读取中央 `dist/src/validation.js`，需要先具备 `images` 新合同。
3. 对每个新 consumer clone 运行 `preflight-project`；失败时不得创建 Docker、进程、端口或 evidence 资源。
4. 使用全新、不可变 dest 跑四条 lane，每条 lane 三个 admitted repetition。
5. 完成精确 shutdown 和 cleanup readback 后执行 finalization，并保留新 `verify-<project>.json`。

若倒序应用项目修复，旧中央 schema 会在构建镜像前安全拒绝 `images` 字段；它不会创建一个未登记镜像，但也不能完成运行。这是有意的集成门禁。

### 7.2 尚未关闭的证据缺口

- **MS-013 / MS-018**：历史两侧都失败，且失败点并不相同。没有新通过对照，不应改 go-like。
- **完整 fresh campaign**：本轮完成了真实组件和 Docker 控制，但没有把修复写入原始脏 checkout，也没有创建新的四车道 campaign dest。最终 conformance 仍需按上述顺序集成后取得。
- **历史 final certificate**：旧 dest 不回填。尝试按当前门禁只读核验时，旧 cleanup 流程或 producer SHA 不满足新合同；未写入任何历史证书。
- **复杂 YAML**：preflight 故意只接受当前项目使用的普通、单引号和双引号 image scalar，不支持 anchors、folded 或 multiline image。出现真实项目需求时再扩展；目前引入通用 YAML 解析器没有证据收益。
- **staging fixture**：需要单独决定是更新冻结 producer fixture，还是在专用 `cd15313…` checkout 运行那两项测试；本轮没有擅自改变历史基准。

## 八、对 go-like 后续优化的建议

### P0：先把证据框架集成并跑新 dest

这是当前收益最大的动作。40 项目实践已经说明：如果 preflight、身份、终态、cleanup 和最终证书不完整，产品团队会花大量时间修并不存在的库 bug。先把“什么真的失败”做准，能直接减少错误重构。

### P1：把 resident 生命周期用法固化成消费者示例

产品实现不需要改变，但文档或模板应明确：

- `start()` 是生命周期 promise，不是 readiness promise。
- 调用者应独立观察 `start()` rejection。
- readiness 只对明确的 `starting` 状态等待。
- 任一终态应立即报告原始 cause。
- shutdown 必须 stop 后 join。

这不是新增抽象，只是把已经验证正确的模式放到消费者最容易复制的位置。

### P1：产品缺陷继续坚持“失败侧 + 通过对照”门槛

历史上 MS-006、MS-009、MS-020 满足这一条件并已得到有效修复；MS-011、MS-013、MS-016、MS-017、MS-018 不满足。继续执行该门槛，可以避免为了 dual-fail 增加 Core、Web 或 Store 的错误复杂度。

### P2：只在真实语法出现时扩展 preflight

当前窄实现能覆盖现有 consumer，且不新增依赖。只有出现经过审核的 anchors、multiline image 或生成式 Compose 文件时，才应扩展语法或引入标准 YAML parser。

## 九、交付状态

- 所有修改位于隔离分支，原始 `/Users/munmunmiao/Documents/web/likego` 与 `/Users/munmunmiao/Documents/web/go-like-dogfood` checkout 均未被本轮覆盖。
- go-like 产品源码没有修改。
- 历史 campaign 证据没有修改或回填。
- 没有 commit、push、PR、release 或 deploy。
- 工作区中还保留全部未提交差异，等待按第七节顺序审阅和集成。

本轮最终结论：**需要修的主要是消费者与证据 harness，而不是 go-like 产品内核。修复已通过聚焦测试、独立代码审查和真实 Docker 控制；完整 campaign 结论仍以新 dest 的四 lane × 三次 admitted repetition 为最终准绳。**
