import { expect, test } from "bun:test"

import { mutate } from "../../src/client/agent"
import { queryText } from "../../src/client/health"
import { discardBody } from "../../src/client/http"
import { consulSource } from "../../src/config/index"
import { newConsulClient } from "../../src/index"
import * as root from "../../src/index"
import { captureOptions } from "../../src/registry/options"
import { newConsulRegistry } from "../../src/registry/index"
import { newConsulStore } from "../../src/store/index"

const fetch = async function fetchConsul(): Promise<Response> {
  return new Response(null)
}

test("one client is accepted by every socket and a foreign object is rejected", () => {
  const client = newConsulClient({ fetch, address: "http://consul.test/" })
  expect(Object.keys(newConsulRegistry(client)).sort()).toEqual([
    "deregister",
    "getService",
    "register",
    "watch"
  ])
  expect(consulSource(client, { key: "app/config" }).name).toBe("consul")
  expect(typeof newConsulStore(client).write).toBe("function")
  expect(() => newConsulClient(null as never)).toThrow("options must be an object")
  expect(() => newConsulRegistry({} as never)).toThrow("created by newConsulClient")
  expect(() => captureOptions(client, null as never)).toThrow("Registry options must be an object")
  expect(Object.keys(root).sort()).toEqual(["newConsulClient"])
})

test("discardBody survives a throwing body getter and a synchronous cancel", () => {
  const thrown = {
    /** Throws while the cancellation helper inspects the body. */
    get body(): ReadableStream<Uint8Array> {
      throw new Error("body getter failed")
    }
  }
  discardBody(thrown as Response, function ignore(): void {})
  const sync = {
    body: {
      /** Throws before returning a cancellation promise. */
      cancel(): Promise<void> {
        throw new Error("cancel threw")
      }
    }
  }
  discardBody(sync as unknown as Response, function ignore(): void {})
})

test("agent and health observe a rejected body cancellation", async () => {
  const client = newConsulClient({
    address: "http://consul.test",
    async fetch(): Promise<Response> {
      return {
        ok: false,
        status: 404,
        headers: new Headers({ "X-Consul-Index": "4" }),
        body: {
          /** Rejects cancellation so the socket's observer runs. */
          cancel(): Promise<void> {
            return Promise.reject(new Error("cancel rejected"))
          }
        }
      } as unknown as Response
    }
  })
  const options = captureOptions(client)
  const url = new URL("/v1/agent/service/example", options.origin)
  const signal = new AbortController().signal
  await expect(mutate(options, "deregister", url, null, signal, true)).resolves.toBe("missing")
  await expect(queryText(options, "get", url, signal, true)).resolves.toEqual(["", "4", 404])
  await Bun.sleep(0)
})
