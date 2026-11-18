/**
 * One standard Fetch call. The global `fetch` satisfies it.
 * Plugs never close it.
 */
export type Fetch = (request: Request) => Promise<Response>
