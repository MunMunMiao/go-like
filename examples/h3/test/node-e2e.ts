import { background } from "@likego/context"
import { newHandler } from "@likego/example-h3"
import { newNodeServer } from "@likego/web/node"

const server = newNodeServer(newHandler())
const endpoint = await server.endpoint(background())
const running = server.start(background())
try {
  const response = await fetch(new URL("/status", endpoint))
  const body = await response.text()
  if (response.status !== 200 || body !== '{"framework":"h3","ok":true}') {
    throw new Error(`unexpected H3 response: ${response.status} ${body}`)
  }
} finally {
  await server.stop(background())
  await running
}

process.stdout.write('LIKEGO_EXAMPLE_H3_NODE_E2E={"valid":true}\n')
