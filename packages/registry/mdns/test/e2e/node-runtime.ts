import { createSocket } from "node:dgram"

import { background, withTimeout } from "@likego/context"
import type {
  MDNSBindOptions,
  MDNSDatagramSocket,
  MDNSNetworkInterface
} from "@likego/registry-mdns"
import { newNodeMDNSHost } from "@likego/registry-mdns/node"

/** Reserves and releases one kernel-assigned IPv4 UDP port. */
async function unusedPort(): Promise<number> {
  const socket = createSocket("udp4")
  await new Promise<void>(function bind(resolve, reject): void {
    socket.once("error", reject)
    socket.bind({ address: "127.0.0.1", port: 0 }, resolve)
  })
  const port = socket.address().port
  await new Promise<void>(function close(resolve): void {
    socket.close(resolve)
  })
  return port
}

/** Creates one final wildcard bind for the selected loopback interface. */
function bindOptions(networkInterface: MDNSNetworkInterface, port: number): MDNSBindOptions {
  return Object.freeze({
    family: "ipv4",
    bindAddress: "0.0.0.0",
    port,
    interfaceId: networkInterface.id,
    interfaceAddress: networkInterface.address,
    reuseAddress: true,
    multicastTTL: 255
  })
}

/** Closes one admitted socket and waits for its true terminal. */
async function closeSocket(socket: MDNSDatagramSocket | null): Promise<void> {
  if (socket === null) return
  await socket.close(background())
  await socket.settled()
}

const host = newNodeMDNSHost()
const interfaces = await host.networkInterfaces(background())
const loopback = interfaces.find(function selected(value): boolean {
  return value.family === "ipv4" && value.internal && value.address === "127.0.0.1"
})
if (loopback === undefined) throw new Error("Node mDNS runtime authority requires IPv4 loopback")

let receiver: MDNSDatagramSocket | null = null
let sender: MDNSDatagramSocket | null = null
try {
  const receiverPort = await unusedPort()
  receiver = await host.bindDatagram(background(), bindOptions(loopback, receiverPort))
  sender = await host.bindDatagram(background(), bindOptions(loopback, await unusedPort()))
  const [ctx, cancel] = withTimeout(background(), 2_000)
  try {
    const pending = receiver.receive(ctx)
    await sender.send(background(), new Uint8Array([76, 105, 107, 101, 71, 111]), {
      family: "ipv4",
      address: loopback.address,
      port: receiverPort
    })
    const datagram = await pending
    if (
      datagram.remote.family !== "ipv4" ||
      Array.from(datagram.data).join(",") !== "76,105,107,101,71,111"
    )
      throw new Error("Node mDNS runtime UDP payload did not round-trip")
  } finally {
    cancel()
  }
} finally {
  await closeSocket(sender)
  await closeSocket(receiver)
}
