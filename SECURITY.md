# 安全策略

## 支持范围

LikeGo 尚未发布稳定版本。安全修复只面向最新正式发布版本和 `main` 上尚未发布的下一版本；更早的 `0.x`
版本不承诺回移植。

## 报告漏洞

仓库启用 GitHub private vulnerability reporting 后，请通过 **Security > Report a vulnerability** 私密报告，不要先
创建公开 Issue。报告应包含受影响包与版本、可复现步骤、影响分析和最小验证材料；请勿提交真实凭据、个人数据或生产
数据。

截至 0.0.1 候选阶段，该仓库外部设置尚未启用 private vulnerability reporting，因此当前没有仓库承诺的私密报告
入口。启用它是公开发布前的阻断项；启用前不要把漏洞详情、凭据或生产数据写入公开 Issue。

维护者完成初步确认前不会公开漏洞细节。修复和披露时间取决于影响范围、兼容性与发布验证结果，不作未经核实的固定
时限承诺。

## 发布边界

常规 npm 发布只允许 GitHub Actions 受保护的 `npm` environment 通过 trusted publishing OIDC 执行。仓库和
workflow 不得保存长期 npm token；environment 审批、npm trusted publisher、GitHub branch protection、private
vulnerability reporting 与 Dependabot security updates 属于仓库管理员必须在外部完成的控制项。

npm 只能为已经存在的包配置 trusted publisher，因此 0.0.1 首次建包是一次性 bootstrap 例外：scope owner 使用有效期
最短、仅限 `@likego` scope read/write 的 granular token，在同一受保护 environment 和同一已验证 SHA 上发布并生成
provenance；完成后立即删除 secret、撤销 token并回读，再为全部公共包配置 trusted publisher。后续版本不得继续使用
该 token 路径。
