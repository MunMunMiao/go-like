type Portable = Bun | Deno | process | Buffer | global | require | module | exports | __filename | __dirname
interface Shape {
  readonly value: Portable
}
export type { Portable, Shape }
