# Verificación

go-like usa varias evidence lanes; no conviene reducir todos los resultados a dos clases de pruebas. `bun run test:unit` ejecuta pruebas unitarias deterministas sin servicios externos. `bun run test:e2e` construye los paquetes y verifica localmente proveedores reales, varios runtimes, ejemplos ejecutables y el consumo de tarballs publicados. Las suites Docker inician servicios reales y eliminan los recursos que crean.

Formato, Lint, tipos, build, Runtime E2E, Provider E2E, Example E2E, Published, Soak, Documentation build y Audit deben registrarse por separado. La verificación canónica del repositorio es `bun run verify`: ejecuta en orden `fmt:check`, `lint:check`, `typecheck`, `build` y `test:unit:coverage`. La etapa de cobertura ejecuta una vez cada script de cobertura de root y workspaces y aplica la verificación obligatoria. `examples/payments-ledger` es la única excepción fuera del alcance unitario: también ejecuta el escenario de integración real con PostgreSQL y NATS, por lo que requiere Docker. Consulta la [Verification canónica en inglés](/reference/verification) para las lanes, el baseline histórico y el run record documental.

```sh
bun run verify
bun run test:parallel
bun run test:stability
bun run test:e2e
bun run test:e2e:soak
```

`test:parallel` ejecuta una vez el mismo alcance unitario con dos workers aislados de Bun para comprobar la seguridad en paralelo entre archivos. `test:stability` aleatoriza cada ejecución, repite dos veces cada archivo de prueba y muestra un seed reproducible, sin usar retry. Ambos son controles independientes, no forman parte de la puerta canónica y no sustituyen `verify`; `test:stability` busca dependencias de orden y fallos intermitentes, algo distinto del comportamiento durante 60 minutos que comprueba `test:e2e:soak`.

Los comandos de cada fase sirven solo para acotar un fallo; superar una fase no sustituye `bun run verify`. `bun run fmt` corrige el formato. `bun run lint` aplica las correcciones seguras de Oxlint, vuelve a formatear y falla si queda algún warning. La puerta usa `fmt:check` y `lint:check`, que no modifican archivos; `lint:check` también exige cero warnings. Estos comandos no sustituyen la comprobación de tipos ni ejecutan comportamiento en runtime. E2E y soak siguen siendo comprobaciones locales independientes que se ejecutan cuando hacen falta. `fmt`, `lint`, `typecheck`, `build`, `audit` y `doc:build` son comandos de ingeniería, no otras clases de pruebas. `doc:build` comprueba las rutas VitePress del inglés y de los locales configurados; no demuestra el layout del navegador ni la paridad de traducción. La existencia de un comando no demuestra que haya pasado; hay que revisar el estado terminal y los logs de la ejecución actual. Consulta la [Verification canónica en inglés](/reference/verification) para las lanes, el baseline histórico y el run record documental.
