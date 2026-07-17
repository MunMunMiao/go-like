const object = {
  Bun: 1,
  Deno() {
    return 2
  }
}
class Local {
  process = 3
  Buffer() {
    return 4
  }
}
export const value = object.Bun + object.Deno() + new Local().process
