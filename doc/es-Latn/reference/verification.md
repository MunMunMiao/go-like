# Verificación

Un comando puede existir sin haber pasado. Un carril en verde no implica que funcionen todos los plugs, runtimes, ejemplos o tarballs empaquetados. Hay que registrar el árbol candidato, las versiones de las herramientas, el comando exacto, el estado de salida, los recuentos y la limpieza.

## Carriles de evidencia

| Carril                 | Qué comprueba                                                                               | Servicios externos         | Qué no demuestra un pase                         |
| ---------------------- | ------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------ |
| Formato                | Formato del código y de la documentación                                                    | No                         | Comportamiento en runtime                        |
| Lint                   | Reglas de Oxlint                                                                            | No                         | Tipos ni comportamiento en runtime               |
| Typecheck              | TypeScript de la raíz, de los paquetes, de los ejemplos y de E2E                            | No                         | Salida de build ni comportamiento del proveedor  |
| Unit                   | Pruebas deterministas                                                                       | No                         | Red real, Docker ni tarballs empaquetados        |
| Build                  | ESM y declaraciones de los paquetes                                                         | No                         | Resolución del consumidor                        |
| Runtime E2E            | Fixtures de Bun y Node donde están declarados                                               | Normalmente no             | Todos los plugs                                  |
| Provider E2E           | Consul, etcd, Kubernetes, ZooKeeper, Redis, RabbitMQ, NATS y los demás servicios declarados | Sí                         | Disponibilidad de producción ni CI alojada       |
| Example E2E            | Proceso del ejemplo, petición, readiness, parada y limpieza                                 | A veces                    | Una instalación aparte de cada ejemplo           |
| Published              | Tarballs empaquetados que consumen fixtures de Node y Bun                                   | No, salvo imports de plugs | Publicación en npm                               |
| Soak                   | Comportamiento de HTTP o de servicio de larga duración                                      | Normalmente no             | Una prueba corta, ni todos los plugs             |
| Build de documentación | VitePress                                                                                   | No                         | Layout del navegador ni calidad de la traducción |
| Audit                  | Informe de vulnerabilidades de dependencias                                                 | No                         | Autorización de la aplicación                    |

El inventario público actual es de 20 paquetes y 75 entradas. Véase [Paquetes](/es-Latn/reference/packages).

## Comandos declarados

Desde la raíz del repositorio:

```sh
bun install --frozen-lockfile
bun run verify
```

`bun run verify` ejecuta `test:protobuf`, `fmt:check`, `lint:check`, `typecheck`, `build` y `test:unit:coverage`, en ese orden. La etapa de cobertura ejecuta cada script de cobertura de la raíz y de los workspaces y termina con `coverage:verify`. `examples/payments-ledger` es la excepción del alcance unitario cuyo script de cobertura también ejecuta su escenario de PostgreSQL y NATS y, por tanto, necesita Docker.

`fmt` repara el formato. `lint` aplica las correcciones seguras de Oxlint, formatea el resultado y solo tiene éxito con cero warnings:

```sh
bun run fmt
bun run lint
```

Las etapas sueltas acotan un fallo. Pasar una etapa no sustituye `verify`:

```sh
bun run test:protobuf
bun run fmt:check
bun run lint:check
bun run typecheck
bun run build
bun run test:unit
bun run test:unit:coverage
bun run test:parallel
bun run test:stability
```

`test:unit:coverage` comprueba el inventario de código ejecutable y la cobertura de líneas y de funciones por archivo. No afirma cobertura de ramas. `test:stability` aleatoriza cada ejecución de la raíz y de los workspaces, repite dos veces cada archivo de prueba y muestra el seed. No reintenta. `test:parallel` ejecuta una vez el alcance unitario con dos workers aislados de Bun. Ni stability ni parallel forman parte de `verify`.

El build de la documentación y la auditoría siguen aparte:

```sh
bun run doc:build
bun run audit
```

`test:protobuf` ejecuta el lint y la generación de Buf, comprueba los tipos de los fixtures generados y ejecuta su prueba de integración RPC. No es una comprobación de formato de solo lectura.

## Alcances E2E

Los scripts de la raíz son:

```sh
bun run test:e2e:suites
bun run test:e2e:runtimes
bun run test:e2e:providers
bun run test:e2e:examples
bun run test:e2e:published
bun run test:e2e
bun run test:e2e:soak
bun run test:e2e:grpc-soak
```

Los scripts de alcance construyen primero, salvo `test:e2e:grpc-soak`, que genera protobuf y después ejecuta `e2e/grpc-soak.ts`. Un `bun e2e/run.ts --scope <name>` directo no construye necesariamente. Hay que decir cuál se ejecutó.

El E2E de proveedores necesita sus servicios Docker declarados y la limpieza. Las comprobaciones de publicados empaquetan tarballs y los instalan en consumidores preparados. El soak vale 60 minutos por defecto:

```sh
bun run test:e2e:soak
```

Una ejecución HTTP corta no es ese soak.

Esta página lista los scripts del manifiesto raíz. No registra un estado de salida para ellos. La disposición paso a paso de las suites vive con el runner E2E, no aquí.

## Observación de la cadena de herramientas

El repositorio no declara versiones de runtime ni de herramientas como requisitos de ejecución. Un carril comprueba que cada herramienta necesaria puede ejecutarse y después registra el entorno. Una herramienta ausente, un timeout, un estado distinto de cero o un consumidor que falla hacen fallar la ejecución. Una cadena de versión no.

Las versiones de las dependencias, el lockfile y los fixtures fijos son entradas de reproducibilidad.

## Evidencia de baseline de esta pista de documentación

La auditoría de contrato suministrada informó lo siguiente en el commit `9385dbf5b6a7d913be56a80ade359e1bf9be8675`:

```text
bun run typecheck  -> passed
bun run test:unit  -> passed, 2,736 tests across root and 87 workspaces
bun run fmt:check  -> passed, 1,514 files
source export audit -> 66 declared entries imported without an import error
```

Esa auditoría describe el árbol anterior a la migración. El código actual exporta 75 entradas en 20 paquetes. La auditoría no ejecutó `build`, `doc:build`, `audit`, el E2E de proveedores con Docker, la ejecución entre runtimes, las comprobaciones de tarballs publicados, consultas a npm, la CI alojada ni el soak de 60 minutos. Esta edición de la documentación no sustituye ese registro por un resultado de pase nuevo.

## Qué permite decir un resultado

| Resultado                | Afirmación segura                                                       |
| ------------------------ | ----------------------------------------------------------------------- |
| Inspección de exports    | "El paquete exporta este símbolo en este árbol."                        |
| Typecheck enfocado       | "Este código pasa el typecheck con este comando."                       |
| Prueba unitaria enfocada | "Estos casos pasaron con este comando."                                 |
| `bun run verify`         | "La secuencia verify registrada pasó para este árbol y este entorno."   |
| Provider E2E             | "Este escenario pasó con el servicio y la limpieza registrados."        |
| Fixture de runtime       | "Este fixture pasó con esta versión de runtime."                        |
| Consumidor publicado     | "Este artefacto empaquetado lo consumió el fixture registrado."         |
| Build de documentación   | "VitePress construyó las rutas configuradas."                           |
| Soak                     | "Esta duración y esta carga terminaron con los residuales registrados." |

Usa [Afirmaciones](/reference/claims) para el registro editorial.

## Fronteras conocidas

- Un `publishConfig` del manifiesto no establece la publicación en npm.
- Un archivo de workflow no establece un resultado de CI alojada.
- Un script de paquete puede ser un carril declarado sin un pase reciente.
- Los proveedores en memoria no establecen comportamiento entre procesos ni del protocolo del vendor.
- Un `ReadableStream` Web no establece RPC interno full-duplex.
- Las opciones TLS no establecen autenticación de la aplicación.
- Un timeout de parada no establece que todos los recursos nativos hayan terminado.
