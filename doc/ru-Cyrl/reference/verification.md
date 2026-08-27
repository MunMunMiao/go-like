# Проверка

go-like использует несколько evidence lanes; сводить все результаты к двум классам тестов не стоит. `bun run test:unit` запускает детерминированные unit-тесты без внешних сервисов. `bun run test:e2e` собирает пакеты и локально проверяет реальные провайдеры, разные runtime, исполняемые examples и потребление опубликованных tarball. Docker suites запускают настоящие сервисы и удаляют созданные ресурсы.

Format, Lint, Typecheck, Build, Runtime E2E, Provider E2E, Example E2E, Published, Soak, Documentation build и Audit нужно записывать отдельно. Каноническая проверка репозитория — `bun run verify`: она последовательно выполняет `fmt:check`, `lint:check`, `typecheck`, `build` и `test:unit:coverage`. Этап покрытия один раз запускает каждый coverage script root и workspaces и применяет обязательную проверку. `examples/payments-ledger` — единственное исключение за пределами unit-тестов: его coverage script также запускает реальный интеграционный сценарий PostgreSQL/NATS, поэтому требуется Docker. Полные evidence lanes, исторический baseline и документационный run record находятся в [канонической Verification на английском](/reference/verification).

```sh
bun run verify
bun run test:parallel
bun run test:stability
bun run test:e2e
bun run test:e2e:soak
```

`test:parallel` один раз запускает тот же unit-набор в двух изолированных Bun workers, проверяя безопасность параллельного выполнения файлов. `test:stability` рандомизирует каждый запуск, дважды повторяет каждый тестовый файл и печатает воспроизводимый seed, не используя retry. Обе проверки независимы, не входят в канонический gate и не заменяют `verify`; `test:stability` ищет зависимости от порядка и непостоянные сбои, а не проверяет 60-минутное поведение, как `test:e2e:soak`.

Команды отдельных этапов нужны только для локализации сбоя; их успешное выполнение не заменяет `bun run verify`. `bun run fmt` исправляет форматирование. `bun run lint` применяет безопасные исправления Oxlint, повторно форматирует результат и завершается ошибкой, если остаётся хотя бы один warning. Gate использует не изменяющие файлы `fmt:check` и `lint:check`; `lint:check` также требует ноль warnings. Эти команды не проверяют типы и не выполняют runtime-поведение. E2E и soak остаются отдельными локальными проверками, которые запускают при необходимости. `fmt`, `lint`, `typecheck`, `build`, `audit` и `doc:build` — инженерные команды, а не дополнительные классы тестов. `doc:build` проверяет настроенные VitePress routes английской и локализованных веток; он не доказывает браузерную вёрстку или parity перевода. Наличие команды не доказывает её успешное выполнение; проверяйте terminal status и логи текущего запуска. Полные evidence lanes, исторический baseline и документационный run record находятся в [канонической Verification на английском](/reference/verification).
