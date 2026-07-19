import { test, expect, describe } from "bun:test"
import { humanizeIdentity, formatWebMirrorLine, WEB_ORIGIN_MARKER } from "./displayName"

describe("humanizeIdentity", () => {
  test("Firstname.Surname@domain becomes 'Firstname S.'", () => {
    expect(humanizeIdentity("Aurora.Nicholas@player-ready.co.uk")).toBe("Aurora N.")
  })

  test("all-lowercase emails capitalise properly (the common prod shape)", () => {
    expect(humanizeIdentity("aurora.nicholas@player-ready.co.uk")).toBe("Aurora N.")
    expect(humanizeIdentity("sam.oakes@player-ready.co.uk")).toBe("Sam O.")
  })

  test("all-uppercase local parts are title-cased, not shouted back", () => {
    expect(humanizeIdentity("AURORA.NICHOLAS@player-ready.co.uk")).toBe("Aurora N.")
  })

  test("deliberate inner capitals in a first name are preserved", () => {
    expect(humanizeIdentity("McDonald.Smith@player-ready.co.uk")).toBe("McDonald S.")
  })

  test("no separator in the local part invents no surname", () => {
    expect(humanizeIdentity("aurorasessions@player-ready.co.uk")).toBe("Aurorasessions")
  })

  test("hyphen and underscore act as separators too", () => {
    expect(humanizeIdentity("proxy-debug@player-ready.co.uk")).toBe("Proxy D.")
    expect(humanizeIdentity("proxy_debug@player-ready.co.uk")).toBe("Proxy D.")
  })

  test("more than two segments uses the first name and the last initial", () => {
    expect(humanizeIdentity("mary.jane.watson@player-ready.co.uk")).toBe("Mary W.")
    expect(humanizeIdentity("a.b.c.d@x.co")).toBe("A D.")
  })

  test("non-email identities pass through untouched", () => {
    expect(humanizeIdentity("discord:186188409499418628")).toBe("discord:186188409499418628")
    expect(humanizeIdentity("dev-agent")).toBe("dev-agent")
    expect(humanizeIdentity("hub")).toBe("hub")
  })

  test("empty and malformed input neither throws nor invents a name", () => {
    expect(humanizeIdentity("")).toBe("")
    expect(humanizeIdentity("@player-ready.co.uk")).toBe("@player-ready.co.uk")
    expect(humanizeIdentity("aurora@")).toBe("aurora@")
    expect(humanizeIdentity("a@b@c")).toBe("a@b@c")
    expect(humanizeIdentity("...@player-ready.co.uk")).toBe("...@player-ready.co.uk")
    expect(humanizeIdentity(undefined as unknown as string)).toBe("")
  })
})

describe("formatWebMirrorLine", () => {
  test("marks the web origin and humanizes the author", () => {
    expect(formatWebMirrorLine("Aurora.Nicholas@player-ready.co.uk", "Hey, quickly testing something"))
      .toBe("🌐 **Aurora N.** · Hey, quickly testing something")
  })

  test("the marker is a standard Unicode emoji, not a custom guild emoji", () => {
    expect(WEB_ORIGIN_MARKER).toBe("🌐")
    expect(WEB_ORIGIN_MARKER).not.toContain(":")
    expect(WEB_ORIGIN_MARKER).not.toContain("<")
  })

  test("content is passed through verbatim — markdown in it is never altered", () => {
    const content = "check **this** and `that`\nsecond line"
    expect(formatWebMirrorLine("a.b@x.co", content)).toBe(`🌐 **A B.** · ${content}`)
  })
})
