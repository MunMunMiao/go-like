import type { Context } from "@likego/context"
import { contextHandler, type Handler } from "@likego/web"

import type { ListingUpdate, RealEstateIndex, SearchQuery } from "./service"

/** Parses one required non-negative integer URL parameter. */
function integerParameter(value: string | null, name: string): number {
  if (value === null || !/^\d+$/.test(value)) throw new TypeError(`invalid ${name}`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new RangeError(`${name} exceeds safe integer bounds`)
  return parsed
}

/** Converts unknown JSON into the explicit listing-update shape. */
function listingFrom(value: unknown): ListingUpdate {
  if (value === null || typeof value !== "object") throw new TypeError("invalid JSON body")
  const listingId: unknown = Reflect.get(value, "listingId")
  const city: unknown = Reflect.get(value, "city")
  const priceMinor: unknown = Reflect.get(value, "priceMinor")
  const bedrooms: unknown = Reflect.get(value, "bedrooms")
  const active: unknown = Reflect.get(value, "active")
  const revision: unknown = Reflect.get(value, "revision")
  if (
    typeof listingId !== "string" ||
    typeof city !== "string" ||
    typeof priceMinor !== "number" ||
    typeof bedrooms !== "number" ||
    typeof active !== "boolean" ||
    typeof revision !== "number"
  ) {
    throw new TypeError("invalid listing update")
  }
  return Object.freeze({
    listingId,
    city,
    priceMinor,
    bedrooms,
    active,
    revision
  })
}

/** Builds one search query from standard URLSearchParams. */
function queryFrom(url: URL): SearchQuery {
  const city = url.searchParams.get("city")
  if (city === null) throw new TypeError("city is required")
  return Object.freeze({
    city,
    maximumPriceMinor: integerParameter(
      url.searchParams.get("maximumPriceMinor"),
      "maximumPriceMinor"
    ),
    minimumBedrooms: integerParameter(url.searchParams.get("minimumBedrooms"), "minimumBedrooms")
  })
}

/** Creates the standard Fetch entrypoint for indexing and searching listings. */
export function newRealEstateHandler(index: RealEstateIndex): Handler {
  return contextHandler(async function realEstateHandler(
    ctx: Context,
    request: Request
  ): Promise<Response> {
    const url = new URL(request.url)
    try {
      if (request.method === "POST" && url.pathname === "/v1/listings") {
        return Response.json(await index.index(ctx, listingFrom(await request.json())), {
          status: 202
        })
      }
      if (request.method === "GET" && url.pathname === "/v1/listings/search") {
        return Response.json({ listings: await index.search(ctx, queryFrom(url)) })
      }
      return Response.json({ code: "not_found" }, { status: 404 })
    } catch (error) {
      const message = error instanceof Error ? error.message : "listing request failed"
      const status = error instanceof TypeError || error instanceof RangeError ? 400 : 409
      return Response.json({ code: "listing_rejected", message }, { status })
    }
  })
}
