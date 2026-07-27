import { background } from "@likego/context"
import { newHandler } from "@likego/example-elysia"
import { newNodeServer } from "@likego/web/node"

const server = newNodeServer(newHandler())
const endpoint = await server.endpoint(background())
const running = server.start(background())
try {
  const response = await fetch(new URL("/users/99", endpoint))
  const body = await response.text()
  if (response.status !== 200 || body !== '{"framework":"elysia","id":"99"}') {
    throw new Error(`unexpected Elysia response: ${response.status} ${body}`)
  }
} finally {
  await server.stop(background())
  await running
}

process.stdout.write('LIKEGO_EXAMPLE_ELYSIA_NODE_E2E={"valid":true}\n')
