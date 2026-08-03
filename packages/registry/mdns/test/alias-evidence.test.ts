import { describe, expect, test } from "bun:test"

import { evaluateIPv6AliasEvidence } from "./e2e/alias-evidence"

describe("registry mDNS IPv6 alias evidence", () => {
  test("derives ULA-to-link-local alias proof from raw addresses and one identity lifecycle", () => {
    const valid = evaluateIPv6AliasEvidence({
      advertisedEndpoints: ["http://[fd12:3456:789a::10]:8080/"],
      packetSourceAddresses: ["fe80::42"],
      lifecycle: { identityCount: 1, createCount: 1, updateCount: 2, deleteCount: 1 }
    })
    expect(valid).toEqual({
      advertisedULAObserved: true,
      packetLinkLocalObserved: true,
      singleIdentityLifecycleObserved: true,
      aliasObserved: true
    })

    expect(
      evaluateIPv6AliasEvidence({
        advertisedEndpoints: ["http://[2001:db8::10]:8080/"],
        packetSourceAddresses: ["fe80::42"],
        lifecycle: { identityCount: 1, createCount: 1, updateCount: 2, deleteCount: 1 }
      }).aliasObserved
    ).toBe(false)
    expect(
      evaluateIPv6AliasEvidence({
        advertisedEndpoints: ["http://[fd12:3456:789a::10]:8080/"],
        packetSourceAddresses: ["2001:db8::42"],
        lifecycle: { identityCount: 1, createCount: 1, updateCount: 2, deleteCount: 1 }
      }).aliasObserved
    ).toBe(false)
    expect(
      evaluateIPv6AliasEvidence({
        advertisedEndpoints: ["http://[fd12:3456:789a::10]:8080/"],
        packetSourceAddresses: ["fe80::42"],
        lifecycle: { identityCount: 2, createCount: 2, updateCount: 2, deleteCount: 1 }
      }).aliasObserved
    ).toBe(false)
  })
})
