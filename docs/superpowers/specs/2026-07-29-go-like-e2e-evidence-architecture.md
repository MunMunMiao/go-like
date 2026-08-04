# go-like E2E 实证研究与架构依据

日期：2026-07-29

范围更正：2026-08-02

状态：研究完成；作为 [E2E 优化设计](./2026-07-29-go-like-e2e-optimization-design.md) 的证据来源保留。

## 1. 产品边界

go-like 的 portable public contracts 使用标准 Web API，显式 runtime adapter 只负责自己的 subpath。平台兼容性由所选 JavaScript runtime 对相应 API 的支持决定。

E2E runner 会启动测试命令、Docker 服务和临时 consumer，但这些行为属于仓库验证基础设施，不是发布 package 的宿主机合同。测试 runner 不承担恶意进程沙箱或操作系统级 containment 职责。

## 2. 已观察的仓库事实

- 根目录只有 unit 与 E2E 两类测试。
- Hosted Verify/Release 只执行 frozen install、format、typecheck、build 和 unit。
- Root E2E 使用 typed definitions 选择 suite、provider、runtime、examples 和 published consumer。
- Package/provider assertions 位于 owning workspace；root 只负责选择、生命周期、清理和汇总。
- Examples input 从当前 immediate workspaces 动态生成，不依赖 committed 数量。
- Docker resources 使用 invocation 与 owner labels，root backstop 只清理当前测试已授权的资源。
- Published lane 使用真实 tarball、隔离安装和 package-name import。
- k6 workload 是 committed TypeScript；短运行与长时间 soak 是不同证据。

## 3. 采用的设计

### 3.1 Build 与 selection

公共 lane 只执行一次 root package build，内部 CLI 不隐式 build。Scope 与显式 suite 互斥；未知、缺失、重复或空选择 fail closed。

Registered runtime plan 对登记项验证 cwd、manifest、script 和精确 argv。新增 runtime support 必须同时更新 registration、fixture、文档和 typecheck owner。

### 3.2 Assertions ownership

- package/provider 场景拥有协议、权限、readiness、恢复和业务断言；
- example 拥有应用行为；
- published lane 拥有 tarball、类型解析和 runtime execution；
- root 拥有 selection、version preflight、timeout、cleanup、sanitized diagnostics 和 summary。

Root 不解析任意 stdout 建立第二套通过协议，也不复制 package 或 example 断言。

### 3.3 Examples completeness

Root 为每个动态 input 分配 child owner。Worker durable registration 获得 authenticated ACK 后才能启动 scenario。完成时比较 inputs、participants、results 和 completed commands；任何集合差、非零退出、timeout、abort 或 cleanup failure 都使 aggregate 失败。

### 3.4 Docker ownership

Scenario 通过共享 API 创建 container、network 和 volume，并注入 exact invocation/owner labels。正常路径由 scenario 清理；root backstop 只处理当前 invocation 与已注册 owner 的交集。Foreign 或 collision resource 保持 untouched。

### 3.5 Published 与 runtime fidelity

Node consumer 执行真实 TypeScript emit，Bun consumer 禁止隐式安装，Deno consumer 先 check 再以最小权限运行。所有 consumer 只从隔离安装后的 package name 导入。

### 3.6 k6 与 soak

k6 workload 独立 typecheck、保持未 bundle，并由 fixed-digest image 直接执行。10 秒结果只证明 short lifecycle；long-duration claim 需要单独实际完成至少 60 分钟。

## 4. 明确拒绝的复杂度

- 不把宿主机 containment 当作产品支持、PR 或 release 门禁。
- 不维护 committed package/example inventory。
- 不增加 source scanner、manifest self-proof 或 evidence overlay。
- 不使用 retry、skip、force-exit、空测试或吞 cleanup error 换取绿色。
- 不为测试编排改变产品 public API。

## 5. 证据诚实性

只有实际结束且 exit 0 的命令可以报告通过。Partial command 不能描述为 full；hosted CI green 不能描述为本地 E2E green；短运行不能描述为长时间稳定性证据。

每次候选验证记录 commit/tree、实际 runtime 版本、所选 scope、完成命令、exit、动态数量以及本次观察到的 Docker/process cleanup 结果。未执行的非产品宿主机实验不影响平台支持声明。
