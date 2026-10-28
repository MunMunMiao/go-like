import { constants, type ClientHttp2Stream, type IncomingHttpHeaders } from "node:http2"

/** Preserves a fully received HTTP/2 response until its consumer drains the native buffer. */
export function preserveCompletedResponse(stream: ClientHttp2Stream): ClientHttp2Stream {
  let completed = false
  function receivedHeaders(_headers: IncomingHttpHeaders, flags: number): void {
    completed ||= (flags & constants.NGHTTP2_FLAG_END_STREAM) !== 0
  }
  stream.once("response", receivedHeaders)
  stream.once("trailers", receivedHeaders)
  const original = stream[Symbol.asyncIterator].bind(stream)
  stream[Symbol.asyncIterator] = async function* responseBody() {
    const iterator = original()
    let draining = false
    return yield* {
      [Symbol.asyncIterator]() {
        return this
      },
      async next() {
        if (!draining) {
          try {
            return await iterator.next()
          } catch (error) {
            if (
              !completed ||
              stream.rstCode !== 0 ||
              !(error instanceof Error) ||
              !("code" in error) ||
              error.code !== "ERR_STREAM_PREMATURE_CLOSE"
            )
              throw error
            // Deno may close a completed stream while its final bytes remain buffered.
            draining = true
          }
        }
        const value = stream.read()
        return value === null
          ? { done: true as const, value: undefined }
          : { done: false as const, value }
      },
      ...(iterator.return === undefined ? {} : { return: iterator.return.bind(iterator) }),
      ...(iterator.throw === undefined ? {} : { throw: iterator.throw.bind(iterator) })
    }
  }
  return stream
}
