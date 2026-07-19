import { expect } from "bun:test"
import * as matchers from "@testing-library/jest-dom/matchers"
import { GlobalRegistrator } from "@happy-dom/global-registrator"

if (typeof document === "undefined") GlobalRegistrator.register({ url: "http://localhost/" })
expect.extend(matchers)

/** happy-dom installs ONE window for the whole `bun test` process, so `innerWidth` is shared
 *  state across every test file. Components read it to pick a layout branch, so a file that
 *  leaves a phone width behind silently changes how the next file renders — which is how a
 *  desktop-only assertion can pass in a full run and fail in isolation. Files that care about
 *  layout set the width they need and hand it back; they never inherit the previous file's. */
export const DEFAULT_VIEWPORT_WIDTH = 1280

export function setViewport(width: number): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width })
  window.dispatchEvent(new Event("resize"))
}

export const resetViewport = (): void => setViewport(DEFAULT_VIEWPORT_WIDTH)

resetViewport()
