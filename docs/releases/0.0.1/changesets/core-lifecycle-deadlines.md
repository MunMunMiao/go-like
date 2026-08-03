---
"@likego/core": patch
---

新增 `startTimeout` startup admission deadline，将 `stopTimeout` 扩展为覆盖完整 shutdown pipeline 的单一
绝对 deadline，并让 Registrar caller wait、迟到 register 补偿与 Node 第二次信号强退具备可验证边界。

timeout 只限制 caller 等待，不声明不合作 Promise 或底层资源已经 terminal；所有迟到结果继续被观察。
