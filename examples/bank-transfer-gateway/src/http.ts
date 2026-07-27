import type { Context } from "@likego/context"
import { contextHandler, type Handler } from "@likego/web"
import { transferQuoteCommandFrom } from "./contract"
import type { TransferQuote, TransferQuoteCommand } from "./service"

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
      return Response.json(await quote(ctx, transferQuoteCommandFrom(await request.json())))
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
