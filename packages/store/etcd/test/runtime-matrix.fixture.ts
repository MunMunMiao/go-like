import { background } from "@go-like/context"
import { newEtcdStore } from "@go-like/store-etcd"

let calls = 0
let path = ""
const store = newEtcdStore({
  address: "http://etcd.internal:2379",
  async fetch(request) {
    if (!(request instanceof Request)) throw new Error("Store did not use standard Request")
    if (request.method !== "POST") throw new Error("Store did not use POST")
    if (request.redirect !== "error") throw new Error("Store redirect policy is not strict")
    if (request.headers.get("content-type") !== "application/json") {
      throw new Error("Store did not use the JSON gateway content type")
    }
    await request.json()
    calls += 1
    path = new URL(request.url).pathname
    return new Response('{"header":{"revision":"1"}}', {
      headers: { "content-type": "application/json" }
    })
  }
})

const page = await store.list(background())

console.log(
  JSON.stringify({
    name: store.string(),
    records: page.records.length,
    cursor: page.cursor,
    calls,
    paths: [path]
  })
)
