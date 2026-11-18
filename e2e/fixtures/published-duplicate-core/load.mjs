const duplicateCode = "GO_LIKE_CORE_DUPLICATE_INSTANCE"
const topSpecifier = process.argv[2]
const plugSpecifier = process.argv[3]

function describe(error) {
  const chain = []
  const seen = new Set()
  let current = error
  while (
    current !== null &&
    current !== undefined &&
    typeof current === "object" &&
    !seen.has(current)
  ) {
    seen.add(current)
    chain.push(current)
    current = "cause" in current ? current.cause : undefined
  }
  const selected = chain.find((item) => item.code === duplicateCode) ?? chain[0]
  if (selected === undefined) return { name: "", code: "", message: "" }
  return {
    name: selected instanceof Error ? selected.name : "",
    code: typeof selected.code === "string" ? selected.code : "",
    message: selected instanceof Error ? selected.message : ""
  }
}

if (typeof topSpecifier !== "string" || typeof plugSpecifier !== "string") {
  process.stderr.write("duplicate core loader requires the core and plug specifiers\n")
  process.exit(2)
}

let failure = null
try {
  await import(topSpecifier)
  await import(plugSpecifier)
} catch (error) {
  failure = error
}

const described = describe(failure)
process.stdout.write(`${JSON.stringify(described)}\n`)
process.exit(described.code === duplicateCode ? 1 : 2)
