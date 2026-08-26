# Запись на приём в клинике: от 0 до 1

Это guided-путь от 0 до 1 для небольшого проекта, где go-like изучается через конкретный бизнес-инвариант, а не через очередной обобщённый Todo. Здесь описаны целевая форма и исполняемые checkpoints; это не утверждение, что целевое дерево уже собрано в готовое приложение для копирования. Проект — сервис записи в клинику с внутрипроцессным сервисом политики, авторитетным repository записей, временным кешем доступности, health-эндпоинтами и одним явным жизненным циклом приложения.

В репозитории уже есть `examples/healthcare-appointments`, от которого начинается этот материал. Текущий код использует для сервиса политики необработанный JSON на границе `Message`. Типизированная версия с `Endpoint` и `Struct` ниже — документированный путь улучшения, построенный на текущих публичных exports; в рамках этой фазы документации она не добавлялась в example. При описании проверки сохраняйте это различие.

## Инвариант

Сервис должен соблюдать пять правил:

1. У врача не может быть пересекающихся активных записей.
2. Отмена освобождает временной слот.
3. Повтор той же заявки с тем же appointment ID идемпотентен.
4. Повторное использование appointment ID с другим содержимым отклоняется.
5. Доступность кешируется только для ускорения; repository остаётся источником истины.

Текущий пример в репозитории реализует первые четыре правила с репозиторием в памяти и проверяет максимальную длительность приёма через внутренний сервис политики. Он не заявляет базу данных, распределённую блокировку, долговечный cache, аутентификацию или production-ready процесс записи.

## Что вы построите

```text
clinic-appointments/
|-- package.json
|-- tsconfig.json
|-- README.md
|-- src/
|   |-- contract.ts       # typed policy Endpoint and Structs
|   |-- service.ts        # domain invariant and canonical repository
|   |-- transport.ts      # policy Server and Client over Memory Transport
|   |-- cache.ts          # availability cache and invalidation policy
|   |-- http.ts           # Fetch routes and health delegation
|   `-- main.ts           # one composition root and one Core App
`-- test/
    |-- main.test.ts      # domain, typed call, HTTP, cache, health, cancellation
    `-- node-e2e.ts       # real bind, request, stop, and port release
```

Текущий пример в workspace имеет более компактное дерево:

```text
examples/healthcare-appointments/
|-- package.json
|-- tsconfig.json
|-- README.md
|-- src/
|   |-- service.ts
|   |-- transport.ts      # current raw JSON policy boundary
|   |-- http.ts
|   `-- main.ts
`-- test/main.test.ts
```

Второе дерево — источник истины для того, что уже находится в checkout. Первое — целевая форма для этапов учебного проекта.

## Предварительные условия и команды

Из корня репозитория:

```sh
bun install --frozen-lockfile
```

В этом checkout пакеты подключаются как workspace dependencies. Репозиторий не использует версии сред выполнения или инструментов как условие допуска к запуску. Каждый выбранный контур проверки убеждается, что необходимые инструменты запускаются, и записывает наблюдаемое окружение. Результат определяют поведение и итог команд, а не номера версий. Текущая документация пакетов сообщает, что они ещё не опубликованы в npm.

Запустите существующий исходный пример:

```sh
HOST=127.0.0.1 PORT=3000 bun run --cwd examples/healthcare-appointments start
```

Скрипт `start` собирает корневые пакеты, создаёт подготовленный Node bundle и запускает его. Перед отправкой трафика дождитесь строки `GO_LIKE_EXAMPLE_READY`. В другом терминале:

```sh
NOW=$(($(date +%s) * 1000))
curl -i -sS http://127.0.0.1:3000/v1/appointments \
  -H 'content-type: application/json' \
  -d "{\"appointmentId\":\"appointment-1\",\"doctorId\":\"doctor-1\",\"patientId\":\"patient-1\",\"startsAt\":$((NOW + 3600000)),\"endsAt\":$((NOW + 5400000))}"

curl -i -sS -X DELETE \
  http://127.0.0.1:3000/v1/appointments/appointment-1
```

Остановите процесс переднего плана через `Ctrl-C`. Не запускайте вторую скрытую App для сервиса политики: текущий пример помещает policy Server и Web Server в один Core App.

Целевые проверки текущего примера:

```sh
bun run --cwd examples/healthcare-appointments typecheck
bun run --cwd examples/healthcare-appointments test:unit
```

В примере также объявлен E2E wrapper:

```sh
bun run --cwd examples/healthcare-appointments test:e2e
```

Эта команда собирает и запускает E2E-задачу примера. Это команда для выполнения, а не утверждение, что текущий checkout уже прошёл её.

## M0: сначала правила предметной области

Модуль предметной области использует Context-first стиль, хотя критическая секция репозитория в памяти синхронна. Так на границе остаются видимыми отмена и возможная будущая замена провайдера:

```ts
import type { Context } from "@go-like/context"

export interface BookAppointmentCommand {
  readonly appointmentId: string
  readonly doctorId: string
  readonly patientId: string
  readonly startsAt: number
  readonly endsAt: number
}

export type AppointmentStatus = "booked" | "cancelled"

export interface Appointment extends BookAppointmentCommand {
  readonly status: AppointmentStatus
}

export interface AppointmentRepository {
  book(ctx: Context, command: BookAppointmentCommand): Appointment
  cancel(ctx: Context, appointmentId: string): Appointment
  get(ctx: Context, appointmentId: string): Appointment | undefined
}
```

Перед изменением состояния repository должен проверять `ctx.err()`. Текущий пример делает это в `newMemoryAppointmentRepository()` и хранит вместе с каждой записью отпечаток. Предикат пересечения имеет вид:

```ts
function overlaps(
  leftStartsAt: number,
  leftEndsAt: number,
  rightStartsAt: number,
  rightEndsAt: number
): boolean {
  return leftStartsAt < rightEndsAt && rightStartsAt < leftEndsAt
}
```

Этот predicate разрешает соседние записи, но отклоняет пересекающиеся активные записи одного врача. При отмене сохранённая запись получает статус `cancelled`; повторная отмена возвращает ту же отменённую запись.

### Тесты M0

Напишите эти тесты до добавления HTTP или транспорта:

```ts
import { background } from "@go-like/context"
import { expect, test } from "bun:test"

// The concrete repository factory is the one in src/service.ts.
test("rejects an overlapping active slot", () => {
  const repository = newMemoryAppointmentRepository()
  const book = newBookAppointment(repository, () => 1_000)
  book(background(), {
    appointmentId: "a-1",
    doctorId: "doctor-1",
    patientId: "patient-1",
    startsAt: 2_000,
    endsAt: 3_000
  })

  expect(() =>
    book(background(), {
      appointmentId: "a-2",
      doctorId: "doctor-1",
      patientId: "patient-2",
      startsAt: 2_500,
      endsAt: 3_500
    })
  ).toThrow("doctor time conflict")
})
```

В текущем `test/main.test.ts` есть этот сценарий, а также повторное использование после отмены, идемпотентная отмена и проверка HTTP handler. Пока команда выше не запущена в вашем окружении, это проверенное содержимое репозитория, но не результат текущего запуска.

## M1: типизированный внутренний сервис политики

Типизированный внутренний контракт использует `@go-like/struct` и `@go-like/transport`. Это runtime-валидация на границе unary Message, а не IDL и не сгенерированный RPC service.

### `src/contract.ts`

```ts
import { struct, type Infer } from "@go-like/struct"
import { endpoint } from "@go-like/transport"

const CheckRequest = struct.object({
  appointmentId: struct.string(),
  doctorId: struct.string(),
  patientId: struct.string(),
  startsAt: struct.number(),
  endsAt: struct.number()
})

const CheckResponse = struct.object({
  allowed: struct.boolean()
})

export type CheckRequest = Infer<typeof CheckRequest>
export type CheckResponse = Infer<typeof CheckResponse>

export const checkAppointment = endpoint(
  "appointment-policy",
  "AppointmentPolicy.Check",
  CheckRequest,
  CheckResponse
)
```

Route tokens видимы и используют ASCII; они не могут содержать `/` или `*`. `Endpoint` содержит экземпляры request и response Struct и два route token. Он не описывает сетевой адрес или сгенерированный client.

### `src/transport.ts`

```ts
import { newClient, withAddress, withTransport } from "@go-like/client"
import type { Context } from "@go-like/context"
import {
  address,
  handler,
  newServer,
  transport as serverTransport,
  type Server
} from "@go-like/server"
import { newMemoryTransport } from "@go-like/transport-memory"

import { checkAppointment, type CheckRequest, type CheckResponse } from "./contract"

const policyAddress = "memory://appointment-policy"

export interface AppointmentPolicy {
  readonly server: Server
  validate(ctx: Context, request: CheckRequest): Promise<CheckResponse>
  close(ctx: Context): Promise<void>
}

export function newAppointmentPolicy(maximumDurationMs = 7_200_000): AppointmentPolicy {
  const transport = newMemoryTransport()
  const client = newClient(withTransport(transport))
  const server = newServer(
    serverTransport(transport),
    address(policyAddress),
    handler(checkAppointment, (_ctx, request) => {
      if (request.endsAt - request.startsAt > maximumDurationMs) {
        throw new Error("appointment duration exceeds policy")
      }
      return { allowed: true }
    })
  )

  return Object.freeze({
    server,
    async validate(ctx: Context, request: CheckRequest): Promise<CheckResponse> {
      return await client.call(ctx, checkAppointment, request, withAddress(policyAddress))
    },
    close(ctx: Context): Promise<void> {
      return client.close(ctx)
    }
  })
}
```

Текущий закреплённый в репозитории пример использует raw `Message` policy handler и `serviceError(...)` со статусом `409`. Это корректная низкоуровневая граница. Типизированная версия выше меняет codec request и response, но не модель владения: один экземпляр Memory Transport, один внутренний Server, один Client и явный close.

### Передавайте тот же Context

Сценарий записи должен передавать тот же request Context policy Client и repository:

```ts
async function validatedBook(ctx: Context, command: CheckRequest): Promise<Appointment> {
  await policy.validate(ctx, command)
  return repository.book(ctx, command)
}
```

Замена `ctx` на `background()` отбросит deadline, cancellation и Context ancestry запроса. Это регрессия корректности, а не безобидное упрощение.

### Тесты M1

Проверьте всё перечисленное:

| Тест                     | Ожидаемый результат                                |
| ------------------------ | -------------------------------------------------- |
| корректный typed request | `allowed: true` и созданная запись                 |
| слишком длинная запись   | policy failure до изменения repository             |
| неверный тип поля        | typed request decode failure                       |
| неверная форма response  | typed response encode failure на границе Server    |
| отменённый Context       | policy и repository наблюдают одну и ту же отмену  |
| client close             | очистка resident Transport Client выполняется явно |

Тест policy в текущем example уже проверяет отказ до изменения repository и успешный путь `Client -> Memory Transport -> Server`. Типизированный тест — предлагаемое расширение.

## M2: Cache доступности

Cache полезен для проекции чтения, но не для источника истины при записи. Пакет Cache предоставляет Context-first `get`, `put` и `delete`; `@go-like/cache-memory` даёт `newMemoryCache()`, а `@go-like/cache` — `expiresIn(...)`:

```ts
import { expiresIn } from "@go-like/cache"
import { newMemoryCache } from "@go-like/cache-memory"

const availabilityCache = newMemoryCache()

async function readAvailability(ctx: Context, doctorId: string) {
  const key = `availability/${doctorId}`
  const cached = await availabilityCache.get(ctx, key)
  if (cached !== null) {
    return JSON.parse(new TextDecoder().decode(cached)) as Availability
  }

  const authoritative = repository.readAvailability(ctx, doctorId)
  await availabilityCache.put(
    ctx,
    key,
    new TextEncoder().encode(JSON.stringify(authoritative)),
    expiresIn(30_000)
  )
  return authoritative
}

async function invalidateAvailability(ctx: Context, doctorId: string): Promise<void> {
  await availabilityCache.delete(ctx, `availability/${doctorId}`)
}
```

`repository.readAvailability(...)` — метод приложения из этого tutorial, а не export go-like. После авторитетной мутации booking и cancellation должны инвалидировать ключ. Если invalidation не удалась, сообщите об этом и выберите явную consistency policy; не считайте cache источником истины для записи.

### Тесты M2

- miss читает repository и заполняет cache;
- hit не читает repository повторно;
- booking или cancellation удаляет projection;
- истёкшее значение приводит к чтению из repository;
- ошибка cache не превращает корректное чтение из источника истины в ложный результат booking;
- после перезапуска процесса состояние Memory Cache исчезает по замыслу.

## M3: liveness и readiness

Создайте Registry в composition root и направьте два пути в `createHealthHandler(...)`:

```ts
import { createHealthHandler } from "@go-like/web/health"
import { newProbeRegistry } from "@go-like/health"
import type { Handler } from "@go-like/web"

const probes = newProbeRegistry()
probes.register("ready", "policy", async (ctx) => {
  await policy.server.endpoint(ctx)
})

const healthHandler = createHealthHandler(probes)
const appointmentHandler: Handler = newAppointmentHandler(book, cancel)

const webHandler: Handler = (request) => {
  const path = new URL(request.url).pathname
  if (path === "/livez" || path === "/readyz") return healthHandler(request)
  return appointmentHandler(request)
}
```

Маршруты по умолчанию — `/livez` и `/readyz`. Пустой liveness считается исправным; пустой readiness закрывается с отказом. Приведённая выше проверка `policy` делает readiness зависимым от допуска внутреннего listener, но не притворяется, будто внешняя база данных определяет liveness процесса.

Сервис для production должен добавлять только те readiness dependencies, которые действительно обязательны для трафика. Имена probes — публичные идентификаторы, а health payloads намеренно очищены.

## M4: один владелец жизненного цикла

Composition root должен создать ресурсы один раз и поместить их под одну App:

```ts
import process from "node:process"
import { afterStart, afterStop, name, newApp, server } from "@go-like/core"
import { signal } from "@go-like/core/node"
import { hostname, newNodeServer, port } from "@go-like/web/node"

const policy = newAppointmentPolicy()
const httpServer = newNodeServer(webHandler, hostname("127.0.0.1"), port(3000))
const app = newApp(
  signal(),
  name("healthcare-appointments"),
  server(policy.server, httpServer),
  afterStart(async (ctx) => {
    await httpServer.endpoint(ctx)
    process.stdout.write("GO_LIKE_EXAMPLE_READY=healthcare-appointments\n")
  }),
  afterStop((ctx) => policy.close(ctx))
)

await app.run()
```

Hook `afterStop` — одна явная граница порядка для policy Client. Core сам останавливает соседние Servers конкурентно. Если нужен более сложный порядок зависимостей, объедините зависимые ресурсы в один Server или явный hook, а не полагайтесь на порядок объявления.

`signal()` — адаптер процесса Node/Bun. Домен, типизированный контракт, Memory Transport и health-модули могут оставаться переносимыми; импорт `@go-like/core/node` — сознательный выбор runtime.

## M5: план тестов и доказательства

| Слой       | Тест                                                            | Цель доказательства                               |
| ---------- | --------------------------------------------------------------- | ------------------------------------------------- |
| Domain     | overlap, cancellation reuse, idempotency, conflicting ID        | поведение `src/service.ts` и результат unit-теста |
| Context    | отменённая booking не меняет repository и не вызывает policy    | целевой Context test                              |
| Typed call | Struct decode/encode, policy rejection, response validation     | граница `@go-like/client` и `@go-like/server`     |
| Cache      | miss, hit, TTL, invalidation, failure fallback                  | тесты `newMemoryCache()`                          |
| Health     | empty liveness, empty readiness, failing probe, 405/404         | `newProbeRegistry()` и `createHealthHandler()`    |
| HTTP       | `POST`, `DELETE`, invalid JSON, conflict status                 | тест стандартного Fetch Handler                   |
| Lifecycle  | policy и Web Server допущены одной App; Client закрывается явно | поведение Core App и Server terminal              |
| Node E2E   | real bind, request, signal, stop, port release                  | example E2E wrapper и остаточные проверки         |

Для текущего example в репозитории целевые команды такие:

```sh
bun run --cwd examples/healthcare-appointments typecheck
bun run --cwd examples/healthcare-appointments test:unit
bun run --cwd examples/healthcare-appointments test:e2e
```

Для всей lane с примерами:

```sh
bun run test:e2e:examples
```

Полный E2E lane собирает пакеты и использует runner репозитория. Docker providers и cross-runtime consumers относятся к отдельным областям. Записывайте candidate commit, версии runtime, exit status, сводку и оставшиеся процессы или контейнеры; наличие скрипта не является результатом pass.

## Этапы

| Этап | Результат                                    | Переходите дальше, когда                                                  |
| ---- | -------------------------------------------- | ------------------------------------------------------------------------- |
| M0   | Domain repository и тесты инвариантов        | поведение overlap и cancellation детерминировано                          |
| M1   | Typed policy Endpoint через Memory Transport | вызов действительно проходит Client/Server/Transport, а не прямую функцию |
| M2   | Cache projection с invalidation              | ошибка cache не может заменить источник истины                            |
| M3   | `/livez` и `/readyz`                         | понятны пустой readiness и failing probes                                 |
| M4   | Одна App, signal, явная очистка Client       | у каждого допущенного ресурса есть один владелец                          |
| M5   | Unit- и Node E2E-доказательства              | результаты записаны с командой и exit status                              |

Не добавляйте Registry, Redis, Vault, настоящий broker, authentication или retries, пока эти этапы не стали понятны. Каждый из них добавляет новую модель владения или отказа, которую стоит вводить сознательно.

## Устранение неполадок

### `Cannot find package "@go-like/..."`

Скорее всего, команда выполняется не из workspace или использует ещё не опубликованный пакет. Запустите `bun install --frozen-lockfile` из корня репозитория и выполните workspace script, например `bun run --cwd examples/healthcare-appointments start`.

### Запрос возвращает `404`

Текущий пример предоставляет только `POST /v1/appointments` и `DELETE /v1/appointments/{appointmentId}`. Проверьте method, path и строку `GO_LIKE_EXAMPLE_READY`. Health routes относятся к расширению tutorial M3, а не к текущему закреплённому примеру.

### Запрос возвращает `400`

Пример требует строковые ID и числовые `startsAt`/`endsAt`. `startsAt` должен быть в будущем относительно внедрённых clock, а `endsAt` — больше `startsAt`. Проверьте, что shell arithmetic создала числа, а не строки в кавычках.

### Запрос возвращает `409`

Слот врача пересекается с активной записью, appointment ID повторно использован с другим содержимым или policy service отклонил длительность. Policy вызывается до мутации repository, поэтому отказ policy не должен создавать запись.

### Typed call сообщает о неверном request или response body

Проверьте, что client и server используют один и тот же `Endpoint` Structs и что request Content-Type в точности равен `application/json`. `handler(contract, fn)` выполняет JSON- и Struct-валидацию на границе Server.

### Memory Client не может достучаться до Server

`newMemoryTransport()` создаёт private address map для каждого экземпляра. Client и Server должны использовать один экземпляр Transport и один в один совпадающий bound `memory:` address. Одинаковый URL в двух отдельно созданных Memory Transport не устанавливает соединение.

### Кажется, что `app.run()` завис

Долгоживущий `Server.start(ctx)` может оставаться pending весь срок работы сервиса. Это ожидаемо. `app.run()` разрешается после stop и конечной очистки, а не сразу после bind listener. Для сигнала допуска используйте `afterStart` или `server.endpoint(ctx)`.

### Остановка возвращает timeout или aggregate error

Timeout ограничивает время ожидания очистки вызывающей стороной. Он не доказывает, что нативный ресурс остановился, а соседние Servers останавливаются конкурентно. Перед тем как считать shutdown чистым, проверьте основную ошибку, terminal barrier адаптера и остаточные данные о процессе или socket.

### Данные кеша исчезли

`@go-like/cache-memory` локален процессу и предназначен для временных данных. Для авторитетных записей используйте явный Store provider и описывайте его реальную долговечность и владение, а не превращайте Cache в базу данных.

## Граница проекта

Этот проект показывает реальный путь через go-like, оставаясь небольшим:

```text
Request
  -> standard Fetch Handler
  -> Context-first appointment use case
  -> typed Client call
  -> Memory Transport
  -> unary Server policy handler
  -> canonical appointment repository
  -> disposable availability Cache
  -> Response

App.stop()
  -> deregistration if configured
  -> concurrent Server stop
  -> explicit Client / provider cleanup
  -> terminal result
```

Он не обучает gRPC, Protobuf, генерации IDL, внутренним full-duplex streams, распределённым блокировкам, долговечной доставке сообщений или аутентификации production-уровня. Это отдельные проектные решения за пределами небольшого проекта.
