import { defineOption, type AppOption, type RuntimeInstaller } from "./options"

/** @internal Registers one runtime-owned lifecycle integration. */
export function runtimeInstaller(install: RuntimeInstaller): AppOption {
  if (typeof install !== "function") throw new TypeError("runtime installer must be a function")
  return defineOption((config) => {
    config.runtimeInstaller = install
  })
}
