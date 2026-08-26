# Проверка

go-like использует несколько evidence lanes; сводить все результаты к двум классам тестов не стоит. `bun run test:unit` запускает детерминированные unit-тесты без внешних сервисов. `bun run test:e2e` собирает пакеты и локально проверяет реальные провайдеры, разные runtime, исполняемые examples и потребление опубликованных tarball. Docker suites запускают настоящие сервисы и удаляют созданные ресурсы.

Format, Lint, Typecheck, Build, Runtime E2E, Provider E2E, Example E2E, Published, Soak, Documentation build и Audit нужно записывать отдельно. `test:unit:coverage` создаёт только необязательный отчёт; полные evidence lanes, исторический baseline и документационный run record находятся в [канонической Verification на английском](/reference/verification).

```sh
bun run test:unit
bun run test:e2e
bun run test:e2e:soak
```

`test:unit:coverage` создаёт только необязательный отчёт. `bun run lint` проверяет статические правила Oxlint; это не проверка типов и не выполнение runtime-поведения. `fmt`, `lint`, `typecheck`, `build`, `audit` и `doc:build` — инженерные команды, а не дополнительные классы тестов. `doc:build` проверяет настроенные VitePress routes английской и локализованных веток; он не доказывает браузерную вёрстку или parity перевода. Наличие команды не доказывает её успешное выполнение; проверяйте terminal status и логи текущего запуска. Полные evidence lanes, исторический baseline и документационный run record находятся в [канонической Verification на английском](/reference/verification).
