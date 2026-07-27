import type { ServiceInstance } from "@likego/registry"
import { expect, test } from "bun:test"

import {
  contentAnnotation,
  decodeManagedSlice,
  decodeSliceList,
  encodeCandidate,
  encodeSlice,
  instanceAnnotation,
  managedByLabel,
  managedByValue,
  wireAnnotation
} from "../src/codec"

const owner = Object.freeze({
  name: "orders-pod",
  uid: "11111111-2222-3333-4444-555555555555"
})

/** Creates one exact instance around a selected endpoint. */
function instance(endpoint: string | null, id = "orders-1"): ServiceInstance {
  return {
    id,
    name: "orders",
    version: "v1",
    metadata: { region: "east" },
    endpoints: endpoint === null ? [] : [endpoint]
  }
}

/** Adds the server-owned fields to one canonical mutation body. */
function committed(body: string, resourceVersion: string): object {
  const value: unknown = JSON.parse(body)
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("encoded EndpointSlice is invalid")
  }
  const metadata = Reflect.get(value, "metadata")
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    throw new Error("encoded EndpointSlice metadata is invalid")
  }
  Reflect.set(metadata, "resourceVersion", resourceVersion)
  return value
}

test("candidate projection supports IP, FQDN, arbitrary schemes, and empty endpoints", async () => {
  await expect(encodeCandidate(instance("http://10.42.0.10:8080/"))).resolves.toMatchObject({
    addressType: "IPv4",
    addresses: ["10.42.0.10"],
    port: 8080
  })
  await expect(encodeCandidate(instance("https://orders.example/"))).resolves.toMatchObject({
    addressType: "FQDN",
    addresses: ["orders.example"],
    port: 443
  })
  await expect(encodeCandidate(instance("http://[2001:db8::1]:9090/"))).resolves.toMatchObject({
    addressType: "IPv6",
    addresses: ["2001:db8::1"],
    port: 9090
  })
  await expect(encodeCandidate(instance("memory://orders"))).resolves.toMatchObject({
    addressType: "FQDN",
    addresses: ["orders"],
    port: 1
  })
  const invalidHostname = await encodeCandidate(instance("https://bad_host.example/"))
  expect(invalidHostname.addresses[0]).toMatch(/\.registry\.likego\.invalid$/)
  for (const endpoint of ["http://127.0.0.1:80/", "http://[::1]:80/", "mailto:test@example.com"]) {
    const fallback = await encodeCandidate(instance(endpoint))
    expect(fallback.addressType).toBe("FQDN")
    expect(fallback.addresses[0]).toMatch(/\.registry\.likego\.invalid$/)
  }
  const empty = await encodeCandidate(instance(null))
  expect(empty.addressType).toBe("FQDN")
  expect(empty.port).toBe(1)
  expect(empty.name).toMatch(/^likego-[a-z2-7]{52}$/)
  expect(empty.identity).toMatch(/^ki-[a-z2-7]{52}$/)
  expect(Object.isFrozen(empty.instance)).toBe(true)
})

test("canonical EndpointSlice round-trips one immutable ServiceInstance", async () => {
  const first = await encodeCandidate(instance("http://10.42.0.10:8080/"))
  const second = await encodeCandidate(instance("custom+rpc://orders:7000", "orders-2"))
  const firstWire = committed(encodeSlice(first, "likego-test", null, owner), "11")
  const secondWire = committed(encodeSlice(second, "likego-test", "10"), "12")

  const decoded = await decodeManagedSlice(firstWire, "likego-test")
  expect(decoded).toMatchObject({
    identity: first.identity,
    content: first.content,
    instance: first.instance,
    owner,
    resourceVersion: "11"
  })
  expect(Object.isFrozen(decoded)).toBe(true)
  expect(Object.isFrozen(decoded?.owner)).toBe(true)

  const snapshot = await decodeSliceList(
    {
      metadata: { resourceVersion: "12" },
      items: [
        secondWire,
        {
          metadata: {
            labels: { [managedByLabel]: "another-controller" },
            namespace: "likego-test"
          }
        },
        firstWire
      ]
    },
    "likego-test"
  )
  expect(snapshot.resourceVersion).toBe("12")
  expect(snapshot.records.map((record) => record.identity)).toEqual(
    [first.identity, second.identity].sort()
  )
  expect(Object.isFrozen(snapshot.records)).toBe(true)
  expect(snapshot.records.find((record) => record.identity === second.identity)?.owner).toBeNull()
})

test("managed payload and projection mismatches fail closed", async () => {
  const candidate = await encodeCandidate(instance("http://10.42.0.10:8080/"))
  const wire = committed(encodeSlice(candidate, "likego-test", null), "7")
  const metadata = Reflect.get(wire, "metadata") as Record<string, unknown>
  const annotations = metadata.annotations as Record<string, unknown>
  annotations[contentAnnotation] = "kc-wrong"
  await expect(decodeManagedSlice(wire, "likego-test")).rejects.toMatchObject({
    code: "LIKEGO_REGISTRY_PROTOCOL"
  })

  const malformed = committed(encodeSlice(candidate, "likego-test", null), "8")
  const malformedMetadata = Reflect.get(malformed, "metadata") as Record<string, unknown>
  const malformedAnnotations = malformedMetadata.annotations as Record<string, unknown>
  malformedAnnotations["registry.likego.dev/service-instance"] = "{"
  await expect(decodeManagedSlice(malformed, "likego-test")).rejects.toMatchObject({
    code: "LIKEGO_REGISTRY_PROTOCOL"
  })

  const wrongNamespace = committed(encodeSlice(candidate, "other", null), "9")
  await expect(decodeManagedSlice(wrongNamespace, "likego-test")).rejects.toMatchObject({
    code: "LIKEGO_REGISTRY_PROTOCOL"
  })
  expect(
    await decodeManagedSlice(
      { metadata: { namespace: "likego-test", labels: { [managedByLabel]: "foreign" } } },
      "likego-test"
    )
  ).toBeNull()
})

test("all malformed managed carriers fail closed at their exact boundary", async () => {
  const candidate = await encodeCandidate(instance("http://10.42.0.10:8080/"))
  /** Creates one fresh committed mutable wire carrier. */
  function wire(): Record<string, unknown> {
    return committed(encodeSlice(candidate, "likego-test", null), "10") as Record<string, unknown>
  }
  /** Reads one mutable metadata carrier. */
  function metadata(value: Record<string, unknown>): Record<string, unknown> {
    return value.metadata as Record<string, unknown>
  }
  /** Reads one mutable annotation carrier. */
  function annotations(value: Record<string, unknown>): Record<string, unknown> {
    return metadata(value).annotations as Record<string, unknown>
  }
  /** Requires one protocol rejection. */
  async function rejects(value: unknown): Promise<void> {
    await expect(decodeManagedSlice(value, "likego-test")).rejects.toMatchObject({
      code: "LIKEGO_REGISTRY_PROTOCOL"
    })
  }

  await rejects(null)

  const missingNamespace = wire()
  delete metadata(missingNamespace).namespace
  await rejects(missingNamespace)

  const wrongMarker = wire()
  annotations(wrongMarker)[instanceAnnotation] = "[]"
  await rejects(wrongMarker)

  const invalidInstance = wire()
  const annotation = JSON.parse(
    String(annotations(invalidInstance)[instanceAnnotation])
  ) as unknown[]
  annotation[1] = {}
  annotations(invalidInstance)[instanceAnnotation] = JSON.stringify(annotation)
  await rejects(invalidInstance)

  const wrongWireVersion = wire()
  annotations(wrongWireVersion)[wireAnnotation] = "3"
  await rejects(wrongWireVersion)

  const missingEndpoints = wire()
  missingEndpoints.endpoints = []
  await rejects(missingEndpoints)

  const missingPorts = wire()
  missingPorts.ports = []
  await rejects(missingPorts)

  const invalidAddresses = wire()
  const endpoint = (invalidAddresses.endpoints as Record<string, unknown>[])[0]
  if (endpoint === undefined) throw new Error("test wire omitted endpoint")
  endpoint.addresses = [1]
  await rejects(invalidAddresses)

  const wrongProjection = wire()
  const port = (wrongProjection.ports as Record<string, unknown>[])[0]
  if (port === undefined) throw new Error("test wire omitted port")
  port.port = 999
  await rejects(wrongProjection)

  const invalidOwners = [
    [],
    [{ apiVersion: "v1", kind: "Service", name: "x", uid: "1" }],
    [{ apiVersion: "v1", kind: "Pod", name: "UPPER", uid: "1" }]
  ]
  for (const ownerReferences of invalidOwners) {
    const invalidOwner = wire()
    metadata(invalidOwner).ownerReferences = ownerReferences
    await rejects(invalidOwner)
  }

  await expect(
    decodeSliceList({ metadata: { resourceVersion: "1" }, items: null }, "likego-test")
  ).rejects.toMatchObject({ code: "LIKEGO_REGISTRY_PROTOCOL" })
})

test("oversized managed payload fails before EndpointSlice I/O", async () => {
  await expect(
    encodeCandidate({
      id: "large",
      name: "orders",
      version: "v1",
      metadata: { payload: "x".repeat(196_608) },
      endpoints: []
    })
  ).rejects.toBeInstanceOf(RangeError)
  expect(managedByValue).toBe("registry-kubernetes.likego.dev")
})
