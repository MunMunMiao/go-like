import type { Context } from "@go-like/context"
import { decodeJson } from "@go-like/struct/codec"
import { contextHandler, type Handler } from "@go-like/web"
import { transferQuoteEndpoint, type TransferQuote, type TransferQuoteCommand } from "./contract"

type QuoteTransferOperation = (
  ctx: Context,
  command: TransferQuoteCommand
) => TransferQuote | PromiseLike<TransferQuote>

/** Creates the standard Fetch endpoint for bank transfer quotes. */
export function newBankTransferHandler(quote: QuoteTransferOperation): Handler {
  return contextHandler(async function bankTransferHandler(
    ctx: Context,
    request: Request
  ): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/transfer-quotes") {
      return Response.json({ code: "not_found" }, { status: 404 })
    }
    try {
      return Response.json(
        await quote(ctx, decodeJson(transferQuoteEndpoint.request, await request.json()))
      )
    } catch (error) {
      const status = error instanceof TypeError || error instanceof RangeError ? 400 : 422
      return Response.json(
        {
          code: "transfer_quote_rejected",
          message: error instanceof Error ? error.message : "quote failed"
        },
        { status }
      )
    }
  })
}
