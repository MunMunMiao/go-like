const urls = process.argv.slice(2)

function describe(error) {
  const cause = error instanceof Error ? error.cause : undefined
  const selected = cause instanceof Error && typeof cause.code === "string" ? cause : error
  return {
    name: selected instanceof Error ? selected.name : "",
    code:
      typeof selected === "object" && selected !== null && typeof selected.code === "string"
        ? selected.code
        : "",
    message: selected instanceof Error ? selected.message : String(selected)
  }
}

const loaded = []
for (const url of urls) {
  try {
    await import(url)
    loaded.push(url)
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ loaded, failed: url, ...describe(error) })}\n`)
    process.exit(0)
  }
}

process.stdout.write(
  `${JSON.stringify({ loaded, failed: null, name: "", code: "", message: "" })}\n`
)
