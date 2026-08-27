---
"@go-like/server": minor
---

增加 `use(selector, ...middleware)` operation middleware，按精确 selector、最长尾部通配前缀与 `*`
fallback 在 dispatcher 构造期选择单一 middleware 序列。
