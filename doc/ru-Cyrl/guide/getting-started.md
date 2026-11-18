# Начало работы

Это руководство ведёт по кратчайшему полезному пути через go-like:

1. Запустить стандартный Fetch Handler на Node-host внутри одного App.
2. Зарегистрировать readiness, чтобы `/readyz` мог пройти.
3. Добавить явный Context запроса, когда Handler выполняет отменяемую работу.
4. Перейти к [проекту записи на приём в клинике](/ru-Cyrl/guide/zero-to-one), когда этот жизненный цикл ясен.

go-like не является роутером. Handler может прийти из обычного Web-кода, Hono, Elysia, H3 или другого фреймворка, который отдаёт стандартную форму Fetch.

## Перед установкой

Корень репозитория приватный и фиксирует версию пакетов `0.0.1`. Эта версия не доказывает доступность в npm. Из рабочей копии:

```sh
bun install --frozen-lockfile
```

Репозиторий не использует версии runtime или инструментов как условие допуска к выполнению. Каждый выбранный lane проверки убеждается, что нужные инструменты запускаются, и записывает наблюдаемое окружение.

Когда опубликованный релиз подтверждён отдельно, небольшому Node Web-сервису нужен один пакет:

```sh
bun add @go-like/core
```

Логи, метрики, трассы и backend экосистем — отдельные plugs. Добавляйте plug только тогда, когда приложение создаёт соответствующий нативный клиент.

## Один Web-сервис

`Handler` находится в `@go-like/core/web`. Node-host — в `@go-like/core/web/node`. Сигналы процесса — в `@go-like/core/node`. Форма ниже — текущее публичное API. Передайте `signal()` сами: core не устанавливает обработчики сигналов. Передайте `readyProbe(probes)` на тот же registry, которым пользуется health Handler, иначе `/readyz` останется закрытым.

```ts
import { name, newApp, readyProbe, server, version } from "@go-like/core"
import { newProbeRegistry } from "@go-like/core/health"
import { signal } from "@go-like/core/node"
import { contextHandler, createHealthHandler, requestContext } from "@go-like/core/web"
import { newNodeServer, port } from "@go-like/core/web/node"

const probes = newProbeRegistry()
probes.register("ready", "warmup", async () => {
  // Check a process-local dependency here. Return to pass, throw to fail.
})

const health = createHealthHandler(probes)
const handler = contextHandler(async (ctx, request) => {
  const { pathname } = new URL(request.url)
  if (pathname === "/livez" || pathname === "/readyz") return await health(request)
  return Response.json({
    path: pathname,
    hasContext: requestContext(request) !== null && ctx.err() === null
  })
})

const web = newNodeServer(handler, port(3000))
export const app = newApp(
  signal(),
  name("hello-web"),
  version("v1"),
  readyProbe(probes),
  server(web)
)

await app.run()
```

`run()` завершается после остановки App. `Ctrl-C` доставляет `SIGINT`. `signal()` сопоставляет первый `SIGTERM`, `SIGQUIT` или `SIGINT` с тем же идемпотентным `App.stop()` и ставит `process.exitCode` в `128` плюс номер сигнала. Следующий сигнал остаётся runtime.

Пустой liveness проходит. Пустой readiness закрыт в отказ. `readyProbe` проходит только после завершения запуска и до начала stop. См. [Проверки и наблюдаемость](/ru-Cyrl/guide/health-observability).

### Первая контрольная точка

- Handler владеет URL-маршрутом.
- `web` владеет слушающим сокетом.
- `app` допускает этот сервер, затем останавливает его.
- `stopTimeout`, если задан, ограничивает, как долго `run()` ждёт. Сам по себе он не завершает нативный сокет, который игнорирует остановку.

## Добавьте Context запроса

`contextHandler` адаптирует `(ctx, request)` к Fetch `Handler`. Host сохраняет Context запроса на `Request`. `requestContext(request)` читает его обратно. Context несёт AppInfo и, когда телеметрия установлена, span `http.server`. Он отменяется, когда запрос заканчивается или прерывается.

```ts
import type { Context } from "@go-like/core/context"
import { contextHandler, type Handler } from "@go-like/core/web"

export const handler: Handler = contextHandler(async (ctx: Context, request: Request) => {
  if (ctx.err() !== null) return new Response(null, { status: 499 })
  const url = new URL(request.url)
  return Response.json({ path: url.pathname })
})
```

Для работы, которая продолжается после того, как Handler вернул тело, наблюдайте также `request.signal`. `contextHandler` завершает свой Context, когда Handler возвращает `Response`.

## Используйте существующий Fetch-фреймворк

Примеры Hono, Elysia и H3 передают Fetch-функцию фреймворка в `newNodeServer` и помещают этот host в `server(...)`. Фреймворк сохраняет маршруты и middleware.

```ts
import { Hono } from "hono"
import { name, newApp, server } from "@go-like/core"
import { signal } from "@go-like/core/node"
import { newNodeServer, port } from "@go-like/core/web/node"

const app = new Hono()
app.get("/hello", (c) => c.json({ ok: true }))

const web = newNodeServer(app.fetch, port(3000))
await newApp(signal(), name("hono"), server(web)).run()
```

Запускаемые копии — `examples/hono`, `examples/elysia`, `examples/h3` и `examples/vanilla-web`.

## Порядок изучения

1. Эта страница: один host, один App, одна ready-проба.
2. [Запись на приём в клинике](/ru-Cyrl/guide/zero-to-one): инвариант предметной области и внутренний унарный вызов.
3. [Архитектура](/ru-Cyrl/guide/architecture): ярус ресурсов, ярус серверов и бюджеты.
4. [Вызовы сервисов](/ru-Cyrl/guide/service-call), затем [Конфигурация, реестр, хранилище и кеш](/ru-Cyrl/guide/config-registry-store).
5. [Проверки и наблюдаемость](/ru-Cyrl/guide/health-observability), когда добавляете логи, метрики или трассы.

## Команды из рабочей копии

Из корня репозитория, после `bun install --frozen-lockfile`:

```sh
bun run --cwd examples/vanilla-web test:unit
bun run --cwd examples/healthcare-appointments test:unit
```

Эти команды проверяют типы и запускают модульные тесты примеров. Они не поднимают Docker и не доказывают публикацию в npm.

## Сбои первого запуска

| Что видно                                       | Что это обычно значит                                                                                                                |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `/readyz` возвращает 503                        | В registry нет проходящей пробы readiness. Зарегистрируйте её, включая `readyProbe(probes)`, если должен учитываться сам App.        |
| Процесс завершается по `SIGTERM` без drain      | `signal()` не передан.                                                                                                               |
| `TypeError: pass telemetry with telemetry(...)` | Набор `Telemetry` передан в `server(...)` или `resources(...)`. Используйте `telemetry(tel)`.                                        |
| Порт уже занят                                  | Его держит другой процесс. Ошибка host — это ошибка listen runtime.                                                                  |
| `Cannot find package`                           | Установка workspace не выполнена, либо импорт всё ещё использует спецификатор до миграции. См. [Миграцию](/ru-Cyrl/guide/migration). |
