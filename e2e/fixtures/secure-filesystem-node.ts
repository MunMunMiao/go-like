import {
  createSecureTempDirectory,
  removeSecureDirectoryTree,
  verifySecureDirectory
} from "../harness/secure-filesystem"

if (Reflect.has(globalThis, "Bun")) {
  throw new Error("Node secure filesystem fixture unexpectedly exposes the Bun global")
}

const directory = await createSecureTempDirectory("node-runtime-")
try {
  await verifySecureDirectory(directory)
} finally {
  await removeSecureDirectoryTree(directory)
}

process.stdout.write("NODE_SECURE_FILESYSTEM_OK\n")
