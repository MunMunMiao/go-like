import { readFileSync, readdirSync, readlinkSync } from "node:fs"

/** Counts mDNS rows in one Linux kernel UDP table. */
function rows(file: string): number {
  let count = 0
  for (const line of readFileSync(file, "utf8").split("\n").slice(1)) {
    const local = line.trim().split(/\s+/, 2)[1]
    if (local?.split(":").at(-1)?.toUpperCase() === "14E9") count += 1
  }
  return count
}

let socketFDs = 0
for (const name of readdirSync("/proc/1/fd")) {
  try {
    if (readlinkSync(`/proc/1/fd/${name}`).startsWith("socket:[")) socketFDs += 1
  } catch {}
}

process.stdout.write(
  JSON.stringify({
    socketFDs,
    udp4Rows: rows("/proc/net/udp"),
    udp6Rows: rows("/proc/net/udp6")
  })
)
