import { expect, test } from "bun:test"

test("builds the HTML entrypoint with bundled JavaScript and CSS", async () => {
  await import("../scripts/build-web")

  expect(await Bun.file("dist/web/index.html").exists()).toBe(true)
  const outputs = [...new Bun.Glob("**/*").scanSync("dist/web")]
  expect(outputs.some(path => path.endsWith(".js"))).toBe(true)
  expect(outputs.some(path => path.endsWith(".css"))).toBe(true)
})
