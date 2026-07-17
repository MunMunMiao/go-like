let value = 0
outer: for (let left = 0; left < 1; left += 1) {
  inner: for (let right = 0; right < 1; right += 1) {
    value += 1
    continue outer
  }
}
export { value }
