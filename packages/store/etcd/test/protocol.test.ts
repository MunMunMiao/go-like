import { background } from "@go-like/context"
import { describe, expect, test } from "bun:test"

import { decodeRow, encodeRecordPayload, encodeText } from "../src/codec"
import { captureOptions, type CapturedOptions } from "../src/options"
import {
  grantLease,
  rangeExact,
  rangePrefix,
  revokeLease,
  transactDelete,
  transactPut
} from "../src/protocol"

interface Script {
  readonly options: CapturedOptions
  readonly requests: readonly Request[]
}

/** Creates one scripted JSON response boundary and request recorder. */
function script(value: unknown): Script {
  const requests: Request[] = []
  const options = captureOptions({
    address: "http://etcd.test",
    fetch(request) {
      requests.push(request)
      return new Response(JSON.stringify(value))
    }
  })
  return Object.freeze({
    options,
    get requests(): readonly Request[] {
      return Object.freeze(Array.from(requests))
    }
  })
}

/** Creates one exact gateway header. */
function header(revision: string = "2"): Readonly<Record<string, string>> {
  return Object.freeze({ revision })
}

/** Creates one valid go-like gateway KV and payload pair. */
function gatewayRow(
  key: string = "protocol/key",
  revision: string = "2",
  lease: string = "0",
  expiresAt: number | null = null
): Readonly<Record<string, unknown>> {
  const payload = encodeRecordPayload(
    { key, value: new Uint8Array([1]), metadata: { owner: "protocol" } },
    "operation",
    expiresAt
  )
  return Object.freeze({
    key: encodeText(key),
    value: encodeText(payload),
    mod_revision: revision,
    lease
  })
}

/** Expects one provider protocol rejection from an async operation. */
async function rejectsProtocol(operation: PromiseLike<unknown>): Promise<void> {
  await expect(operation).rejects.toMatchObject({ code: "GO_LIKE_ETCD_STORE_PROTOCOL" })
}

describe("range and lease protocol", () => {
  test("reads exact current and historical ranges without accepting foreign keys", async () => {
    const current = script({ header: header("2"), kvs: [gatewayRow()] })
    const result = await rangeExact(background(), current.options, "read", "protocol/key", "2")
    expect(result.row?.record.key).toBe("protocol/key")
    const request = current.requests[0]
    if (request === undefined) throw new Error("range request was not captured")
    expect(await request.json()).toEqual({ key: encodeText("protocol/key"), revision: "2" })
    await rejectsProtocol(
      rangeExact(
        background(),
        script({ header: header(), kvs: [gatewayRow("other/key")] }).options,
        "read",
        "protocol/key"
      )
    )
    await rejectsProtocol(
      rangeExact(
        background(),
        script({ header: header(), kvs: [gatewayRow(), gatewayRow()] }).options,
        "read",
        "protocol/key"
      )
    )
    await rejectsProtocol(
      rangeExact(
        background(),
        script({ header: header(), kvs: "invalid" }).options,
        "read",
        "protocol/key"
      )
    )
  })

  test("validates ordered prefix pages, limit, more, and cursor revision fields", async () => {
    const valid = script({
      header: header("7"),
      kvs: [gatewayRow("prefix/a", "3"), gatewayRow("prefix/b", "4")],
      more: true
    })
    const page = await rangePrefix(background(), valid.options, "prefix/", null, "7", 2)
    expect(page).toMatchObject({ revision: "7", more: true })
    const request = valid.requests[0]
    if (request === undefined) throw new Error("prefix request was not captured")
    expect(await request.json()).toMatchObject({
      revision: "7",
      limit: "2",
      sort_order: "ASCEND",
      sort_target: "KEY"
    })
    const malformed: readonly [unknown, number | null][] = [
      [{ header: header(), more: "true" }, 1],
      [{ header: header(), more: true }, null],
      [{ header: header(), more: true }, 1],
      [{ header: header(), kvs: [gatewayRow("other/a")] }, 1],
      [
        {
          header: header(),
          kvs: [gatewayRow("prefix/b", "3"), gatewayRow("prefix/a", "4")]
        },
        2
      ]
    ]
    for (const [value, selectedLimit] of malformed) {
      await rejectsProtocol(
        rangePrefix(
          background(),
          script(value).options,
          "prefix/",
          value === malformed[2]?.[0] ? "prefix/z" : null,
          null,
          selectedLimit
        )
      )
    }
  })

  test("grants and revokes exact signed lease IDs", async () => {
    expect(await grantLease(background(), script({ ID: "-7", TTL: "2" }).options, 1)).toBe("-7")
    await rejectsProtocol(grantLease(background(), script({ ID: "7", TTL: "0" }).options, 1))
    const revoked = script({ header: header("3") })
    await revokeLease(background(), revoked.options, "7")
    const request = revoked.requests[0]
    if (request === undefined) throw new Error("lease revoke request was not captured")
    expect(await request.json()).toEqual({ ID: "7" })
  })
})

describe("transaction protocol", () => {
  test("parses create and replacement put success with exact previous ownership", async () => {
    const created = await transactPut(
      background(),
      script({
        header: header("3"),
        succeeded: true,
        responses: [{ response_put: { header: header("3") } }]
      }).options,
      "protocol/key",
      "payload",
      "0",
      null
    )
    expect(created).toEqual({ succeeded: true, revision: "3", current: null })

    const previousValue = gatewayRow("protocol/key", "3")
    const previous = decodeRow(previousValue, "write")
    const replacement = script({
      header: header("4"),
      succeeded: true,
      responses: [{ response_put: { header: header("4"), prev_kv: previousValue } }]
    })
    const replaced = await transactPut(
      background(),
      replacement.options,
      "protocol/key",
      "payload",
      "0",
      previous
    )
    expect(replaced.current?.record.revision).toBe("3")
    const request = replacement.requests[0]
    if (request === undefined) throw new Error("put transaction was not captured")
    const body: unknown = await request.json()
    expect(body).toMatchObject({
      compare: [
        {
          target: "MOD",
          mod_revision: "3"
        }
      ]
    })
  })

  test("returns failed put comparison state and rejects malformed transaction envelopes", async () => {
    const currentValue = gatewayRow("protocol/key", "5")
    const failed = await transactPut(
      background(),
      script({
        header: header("5"),
        responses: [{ response_range: { header: header("5"), kvs: [currentValue] } }]
      }).options,
      "protocol/key",
      "payload",
      "0",
      null
    )
    expect(failed).toMatchObject({ succeeded: false, revision: "5" })
    expect(failed.current?.record.revision).toBe("5")

    const malformed: unknown[] = [
      { header: header(), succeeded: "true", responses: [] },
      { header: header(), succeeded: true },
      { header: header(), succeeded: true, responses: [] },
      {
        header: header("3"),
        succeeded: true,
        responses: [{ response_put: { header: header("4") } }]
      },
      {
        header: header("0"),
        succeeded: true,
        responses: [{ response_put: { header: header("0") } }]
      },
      {
        header: header("3"),
        succeeded: true,
        responses: [{ response_put: { header: header("3"), prev_kv: currentValue } }]
      }
    ]
    for (const value of malformed) {
      await rejectsProtocol(
        transactPut(background(), script(value).options, "protocol/key", "payload", "0", null)
      )
    }
  })

  test("parses successful and failed delete transactions and validates acknowledgements", async () => {
    const previousValue = gatewayRow("protocol/key", "5")
    const previous = decodeRow(previousValue, "delete")
    const succeeded = await transactDelete(
      background(),
      script({
        header: header("6"),
        succeeded: true,
        responses: [
          {
            response_delete_range: {
              header: header("6"),
              deleted: "1",
              prev_kvs: [previousValue]
            }
          }
        ]
      }).options,
      "protocol/key",
      previous
    )
    expect(succeeded).toMatchObject({ succeeded: true, revision: "6" })

    const failed = await transactDelete(
      background(),
      script({
        header: header("7"),
        responses: [
          { response_range: { header: header("7"), kvs: [gatewayRow("protocol/key", "7")] } }
        ]
      }).options,
      "protocol/key",
      previous
    )
    expect(failed).toMatchObject({ succeeded: false, revision: "7" })

    const malformed: unknown[] = [
      {
        header: header("0"),
        succeeded: true,
        responses: [{ response_delete_range: { header: header("0") } }]
      },
      {
        header: header("6"),
        succeeded: true,
        responses: [
          {
            response_delete_range: { header: header("6"), deleted: "0", prev_kvs: [previousValue] }
          }
        ]
      },
      {
        header: header("6"),
        succeeded: true,
        responses: [{ response_delete_range: { header: header("6"), deleted: "1" } }]
      },
      {
        header: header("6"),
        succeeded: true,
        responses: [
          {
            response_delete_range: {
              header: header("6"),
              deleted: "1",
              prev_kvs: [gatewayRow("protocol/key", "4")]
            }
          }
        ]
      }
    ]
    for (const value of malformed) {
      await rejectsProtocol(
        transactDelete(background(), script(value).options, "protocol/key", previous)
      )
    }
  })
})
