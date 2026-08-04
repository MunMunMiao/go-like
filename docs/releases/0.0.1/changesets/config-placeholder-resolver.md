---
"@go-like/config": minor
---

增加显式的 post-merge 配置 resolver 与 `${dotted.key}` 占位符解析器；解析按 option
顺序发生在 Standard Schema 之前，不读取运行时环境全局，并在重载失败时保留 last-good 配置。
