import { background } from "@go-like/context"
import { newHandler } from "@go-like/example-hono"
import { newNodeServer } from "@go-like/web/node"

const server = newNodeServer(newHandler())
const endpoint = await server.endpoint(background())
const running = server.start(background())
try {
  const response = await fetch(new URL("/users/99", endpoint))
  const body = await response.text()
  if (response.status !== 200 || body !== '{"framework":"hono","id":"99"}') {
    throw new Error(`unexpected Hono response: ${response.status} ${body}`)
  }
} finally {
  await server.stop(background())
  await running
}
