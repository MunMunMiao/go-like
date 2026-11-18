# Запись на приём в клинике: от 0 до 1

Этот путь проводит один бизнес-инвариант через внутренний вызов политики, Fetch Handler, health и один App. Запускаемое дерево — `examples/healthcare-appointments`. Фрагменты ниже используют имена этого примера. Одноразовый кеш доступности — дополнительная веха, которую вы добавляете в том же корне композиции. Это не второй источник истины.

## Инвариант

1. У врача не может быть пересекающихся активных записей.
2. Отмена освобождает слот.
3. Повтор того же идентификатора записи с тем же содержимым идемпотентен.
4. Повторное использование идентификатора записи с другим содержимым отклоняется.
5. Кешированная проекция доступности, если вы её добавите, сама по себе никогда не разрешает запись.

Пример реализует первые четыре правила репозиторием в памяти и проверяет максимальную длительность через `appointment-policy.v1/check`. Он не заявляет базу данных, распределённую блокировку, аутентификацию или производственный процесс клиники.

## Раскладка

```text
examples/healthcare-appointments/
  src/contract.ts    defineService and Structs
  src/service.ts     repository and booking rules
  src/transport.ts   memory Server and Client
  src/http.ts        Fetch handler
  src/main.ts        Node host and App
  test/main.test.ts
```

Из корня репозитория:

```sh
bun install --frozen-lockfile
bun run --cwd examples/healthcare-appointments test:unit
```

Версия пакета `0.0.1` не доказывает доступность в npm. Внутри этой рабочей копии единственная зависимость go-like, которая нужна примеру, — `@go-like/core`.

## M0: правила предметной области

`src/service.ts` владеет `BookAppointmentCommand`, репозиторием и проверкой пересечения. Context — первый аргумент, даже когда репозиторий в памяти не блокируется. Позднейшие store или кеш могут использовать ту же сигнатуру.

Пример отклоняет плохой идентификатор, неположительное окно, пересечение и идентификатор, повторно использованный с другим содержимым. Тесты этих случаев живут рядом с репозиторием, без App и без HTTP.

## M1: сервис политики

`src/contract.ts` связывает операцию:

```ts
import { struct } from "@go-like/core/struct"
import { defineService } from "@go-like/core/transport"

const command = struct.object({
  appointmentId: struct.string(),
  doctorId: struct.string(),
  patientId: struct.string(),
  startsAt: struct.number(),
  endsAt: struct.number()
})

export const appointmentPolicy = defineService("appointment-policy.v1", {
  check: {
    request: command,
    response: struct.object({ allowed: struct.literal(true) })
  }
})
```

`src/transport.ts` ставит оба конца на один транспорт в памяти. Адрес `memory://appointment-policy.v1` — это не имя операции.

```ts
import { newClient, withEndpoint, withTransport } from "@go-like/core/client"
import { address, newServer, transport as serverTransport } from "@go-like/core/server"
import { serviceError } from "@go-like/core/transport"
import { newMemoryTransport } from "@go-like/core/transport/memory"
import { appointmentPolicy } from "./contract"

const transport = newMemoryTransport()
const server = newServer(serverTransport(transport), address("memory://appointment-policy.v1"))
appointmentPolicy.registerHandler(server, {
  check(_ctx, command) {
    if (command.endsAt - command.startsAt > 7_200_000) {
      throw serviceError("appointment_policy_rejected", "appointment duration exceeds policy", 409)
    }
    return { allowed: true as const }
  }
})
const caller = appointmentPolicy.newClient(
  newClient(withTransport(transport), withEndpoint("memory://appointment-policy.v1"))
)
```

`src/http.ts` — это `contextHandler`. Он передаёт Context запроса в запись и отмену. HTTP 400 — это повреждённое тело. HTTP 409 — отклонённая запись. Эти статусы выбирает Web Handler. Сбой политики — это `ServiceError` со статусом 409 на внутреннем вызове.

## M2: кеш доступности

Кеш в памяти необязателен и действует в пределах процесса. Ключи и значения — байты. Репозиторий остаётся авторитетным: попадание пропускает чтение, промах или истечение читает снова, а запись или отмена удаляет ключ. Ошибка кеша не должна превращаться в успешную запись.

```ts
import { expiresIn } from "@go-like/core/cache"
import { newMemoryCache } from "@go-like/core/cache/memory"

const cache = newMemoryCache()
await cache.put(ctx, key, bytes, expiresIn(5_000))
const hit = await cache.get(ctx, key)
```

`newMemoryCache` — это не `Server`. `@go-like/redis/cache` — это `Server`; его помещают в `resources(...)`.

## M3: liveness и readiness

Создайте один registry, направьте на него App и сами разведите `/livez` и `/readyz`. Без `readyProbe` путь `/readyz` остаётся 503.

```ts
import { newApp, readyProbe, server } from "@go-like/core"
import { newProbeRegistry } from "@go-like/core/health"
import { createHealthHandler, type Handler } from "@go-like/core/web"

const probes = newProbeRegistry()
probes.register("ready", "policy", async (ctx) => {
  await policyServer.endpoint(ctx)
})
const health = createHealthHandler(probes)

const handler: Handler = async (request) => {
  const { pathname } = new URL(request.url)
  if (pathname === "/livez" || pathname === "/readyz") return await health(request)
  return appointmentHandler(request)
}

const app = newApp(readyProbe(probes), server(policyServer, web))
void handler
void app
```

## M4: один владелец жизненного цикла

`src/main.ts` в примере — корень композиции: репозиторий, сервис политики, Handler, `newNodeServer`, `signal()` и `afterStart`, который ждёт `endpoint(ctx)`, прежде чем записать `GO_LIKE_EXAMPLE_READY`. Добавьте `readyProbe`, когда открываете `/readyz`. Закройте клиент политики в `afterStop`, если он переживает сервер в памяти.

```ts
import { afterStart, name, newApp, server } from "@go-like/core"
import { signal } from "@go-like/core/node"
import { hostname, newNodeServer, port } from "@go-like/core/web/node"

const httpServer = newNodeServer(handler, hostname(host), port(portNumber))
const app = newApp(
  signal(),
  name("healthcare-appointments"),
  server(policy.server, httpServer),
  afterStart(async (ctx) => {
    await httpServer.endpoint(ctx)
  })
)
await app.run()
```

`server(...)` запускает обоих участников вместе. Сервер политики находится внутри процесса, поэтому ярус ресурсов ему не нужен. Кешу Redis или файловому хранилищу — нужен.

## M5: что устанавливают тесты

`test/main.test.ts` проверяет правила в памяти и внутренний вызов. Прошедший модульный тест не устанавливает Docker, опубликованный tarball или производственную систему записи. Запишите команду, если заявляете результат. См. [Проверку](/ru-Cyrl/reference/verification).

## Диагностика

| Симптом                                    | Что проверить                                                                |
| ------------------------------------------ | ---------------------------------------------------------------------------- |
| `Cannot find package`                      | Выполните `bun install --frozen-lockfile`. Импорты — `@go-like/core/...`.    |
| HTTP 404                                   | Handler не знает этот путь. Маршруты health за вас не монтируются.           |
| HTTP 400                                   | JSON-тело не прошло собственную проверку Handler.                            |
| HTTP 409                                   | Репозиторий или политика отклонили команду.                                  |
| Типизированный вызов не проходит валидацию | Запрос или ответ не совпадает со Struct.                                     |
| Клиент не достигает сервера                | Клиент и сервер должны делить один экземпляр `newMemoryTransport()`.         |
| `app.run()` не возвращается                | Он ждёт остановки. Его завершают `signal()` или `app.stop()`.                |
| `EADDRINUSE`                               | Порт занят.                                                                  |
| Значение кеша исчезло                      | Кеш в памяти действует в пределах процесса. TTL и `delete` тоже его удаляют. |
| `/readyz` равен 503                        | Зарегистрируйте ready-пробу, включая `readyProbe(probes)`.                   |
