# Config adapter runtime package smoke

Executed 2026-07-18 (Asia/Shanghai) after building `@likego/config/env`,
`@likego/config/file`, and `@likego/config-consul`.

Command: `bun run test:runtime`

The smoke staged package manifests plus ignored `dist` output in a temporary `node_modules` tree and
imported all packages only by package name. Development or business source did not import a relative
`dist/*.js` path. The runner also verified that Consul requests use `redirect: "error"` and removed
the temporary publish-shaped stage in `finally`.

| Runtime | Pinned/observed version | Result |
| --- | --- | --- |
| Bun | 1.3.14 | pass |
| Node current | 26.5.0 | pass |
| Deno | 2.9.3 | pass |
| Node LTS Docker | `node@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d` (24.18.0) | pass |

Each runtime produced the same result:

```json
{"env":{"http":{"port":"8080"}},"file":{"enabled":true},"consul":{"release":2}}
```

The scenario exercised explicit environment capture, injected file read and revision, a one-argument
standard Fetch Consul read, JSON decoding, and the portable `Context` boundary.
