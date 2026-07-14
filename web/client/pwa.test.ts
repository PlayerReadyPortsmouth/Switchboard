import "./testSetup"
import { afterEach, describe, expect, test } from "bun:test"
import { act, cleanup, render, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createElement } from "react"
import { InstallButton } from "./components/InstallButton"
import { App, type AppApi } from "./App"
import { isPwaRegistrationAllowed, registerPwa, type BeforeInstallPromptEvent, type PwaState } from "./pwa"

const originalServiceWorker = Object.getOwnPropertyDescriptor(navigator, "serviceWorker")
const originalIsSecureContext = Object.getOwnPropertyDescriptor(globalThis, "isSecureContext")

afterEach(() => {
  cleanup()
  if (originalServiceWorker) Object.defineProperty(navigator, "serviceWorker", originalServiceWorker)
  else Reflect.deleteProperty(navigator, "serviceWorker")
  if (originalIsSecureContext) Object.defineProperty(globalThis, "isSecureContext", originalIsSecureContext)
  else Reflect.deleteProperty(globalThis, "isSecureContext")
  history.replaceState(null, "", "/")
})

function installEvent(prompt: () => Promise<void> = async () => {}) {
  const event = new Event("beforeinstallprompt", { cancelable: true }) as BeforeInstallPromptEvent
  event.prompt = prompt
  event.userChoice = Promise.resolve({ outcome: "accepted", platform: "web" })
  return event
}

const api: AppApi = {
  session: async () => ({
    identity: "ada@example.com",
    agents: [{ name: "architect", alive: true, busy: false }],
    features: { agents: true },
    permissions: { agents: "operator" },
  }),
  listConversations: async () => [],
  createConversation: async () => { throw new Error("not used") },
  archiveConversation: async () => { throw new Error("not used") },
}

describe("registerPwa", () => {
  test("registers /sw.js in secure contexts and on localhost only", async () => {
    const registrations: string[] = []
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { register: async (url: string) => { registrations.push(url) } } })
    Object.defineProperty(globalThis, "isSecureContext", { configurable: true, value: false })

    expect(isPwaRegistrationAllowed(new URL("http://example.test/"), false)).toBe(false)
    expect(isPwaRegistrationAllowed(new URL("http://localhost/"), false)).toBe(true)
    expect(isPwaRegistrationAllowed(new URL("http://127.0.0.1/"), false)).toBe(true)
    expect(isPwaRegistrationAllowed(new URL("https://example.test/"), true)).toBe(true)

    const localhost = registerPwa()
    await Promise.resolve()
    expect(registrations).toEqual(["/sw.js"])
    localhost.dispose()

    Object.defineProperty(globalThis, "isSecureContext", { configurable: true, value: true })
    const secure = registerPwa()
    await Promise.resolve()
    expect(registrations).toEqual(["/sw.js", "/sw.js"])
    secure.dispose()
  })

  test("captures one install prompt and clears availability after prompting", async () => {
    const controller = registerPwa()
    const states: Array<{ installAvailable: boolean; online: boolean }> = []
    const unsubscribe = controller.subscribe(state => states.push(state))
    let prompts = 0
    const event = installEvent(async () => { prompts++ })
    window.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(controller.state().installAvailable).toBe(true)
    await controller.install()
    expect(prompts).toBe(1)
    expect(controller.state().installAvailable).toBe(false)
    expect(states.at(-1)?.installAvailable).toBe(false)
    unsubscribe()
    controller.dispose()
  })

  test("clears install availability when the app is installed", () => {
    const controller = registerPwa()
    window.dispatchEvent(installEvent())
    expect(controller.state().installAvailable).toBe(true)
    window.dispatchEvent(new Event("appinstalled"))
    expect(controller.state().installAvailable).toBe(false)
    controller.dispose()
  })

  test("publishes a sanitized service-worker registration failure", async () => {
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: {
      register: async () => { throw new Error("secret reverse-proxy detail") },
    } })
    const controller = registerPwa()
    await Promise.resolve()
    await Promise.resolve()

    expect(controller.state().issue).toEqual({
      source: "service-worker",
      message: "Switchboard could not enable offline support. Reload the page to try again.",
    })
    expect(JSON.stringify(controller.state())).not.toContain("secret reverse-proxy detail")
    controller.dispose()
  })

  test("publishes a sanitized prompt failure and treats dismissal as no error", async () => {
    const controller = registerPwa()
    window.dispatchEvent(installEvent(async () => { throw new Error("secret prompt detail") }))

    await controller.install()

    expect(controller.state().installAvailable).toBe(false)
    expect(controller.state().issue).toEqual({
      source: "install",
      message: "The install prompt could not open. Reload the page, then try Install Switchboard again.",
    })
    expect(JSON.stringify(controller.state())).not.toContain("secret prompt detail")
    window.dispatchEvent(installEvent())
    const dismissed = installEvent()
    dismissed.userChoice = Promise.resolve({ outcome: "dismissed", platform: "web" })
    window.dispatchEvent(dismissed)
    await controller.install()
    expect(controller.state().issue).toBeNull()
    controller.dispose()
  })

  test("publishes online changes and unsubscribe/dispose remove listeners", () => {
    const controller = registerPwa()
    const values: boolean[] = []
    const unsubscribe = controller.subscribe(state => values.push(state.online))
    window.dispatchEvent(new Event("offline"))
    window.dispatchEvent(new Event("online"))
    expect(values.slice(-2)).toEqual([false, true])

    unsubscribe()
    window.dispatchEvent(new Event("offline"))
    expect(values.slice(-2)).toEqual([false, true])
    controller.dispose()
    window.dispatchEvent(installEvent())
    expect(controller.state().installAvailable).toBe(false)
  })

  test("does not publish a late registration failure after unsubscribe and disposal", async () => {
    let reject!: (reason: unknown) => void
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: {
      register: () => new Promise((_resolve, no) => { reject = no }),
    } })
    const controller = registerPwa()
    const states: PwaState[] = []
    const unsubscribe = controller.subscribe(state => states.push(state))
    unsubscribe()
    controller.dispose()
    reject(new Error("late private detail"))
    await Promise.resolve()
    await Promise.resolve()

    expect(states).toHaveLength(1)
    expect(controller.state().issue).toBeNull()
  })

  test("drives the workspace banner and exact offline limitation copy", async () => {
    let listener: ((state: PwaState) => void) | undefined
    const pwa = {
      state: () => ({ installAvailable: false, online: true, issue: null }),
      subscribe: (next: typeof listener) => { listener = next; next?.(pwa.state()); return () => { listener = undefined } },
      install: async () => {},
    }
    render(createElement(App, { api, pwa }))
    await within(document.body).findByRole("heading", { name: "Switchboard" })

    act(() => listener?.({ installAvailable: false, online: false, issue: null }))

    expect(document.querySelector(".connection-banner")?.getAttribute("data-state")).toBe("offline")
    expect(document.querySelector("[data-workspace-announcer]")?.textContent).toBe("Offline — drafts stay on this device. Messages are not submitted.")
  })

  for (const [layout, width, issue] of [
    ["desktop", 1280, { source: "service-worker", message: "Switchboard could not enable offline support. Reload the page to try again." }],
    ["mobile", 500, { source: "install", message: "The install prompt could not open. Reload the page, then try Install Switchboard again." }],
  ] as const) {
    test(`shows a visible install error with recovery guidance when unavailable on ${layout}`, async () => {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: width })
      const pwa = {
        state: () => ({ installAvailable: false, online: true, issue }),
        subscribe: (listener: (state: PwaState) => void) => { listener(pwa.state()); return () => {} },
        install: async () => {},
      }
      render(createElement(App, { api, pwa }))
      await within(document.body).findByRole("heading", { name: "Switchboard" })

      const status = within(document.body).getByRole("status")
      expect(status.textContent).toContain(issue.source === "install" ? "Install Switchboard" : "Offline support")
      expect(status.textContent).toContain("Reload the page")
      expect(status.closest(".app-rail")).toBeNull()
      expect(within(document.body).queryByRole("button", { name: "Install Switchboard" })).toBeNull()
    })
  }

  test("the install action delegates failures to controller issue state without a duplicate announcement", async () => {
    render(createElement(InstallButton, { available: true, onInstall: async () => {} }))
    await userEvent.click(within(document.body).getByRole("button", { name: "Install Switchboard" }))
    expect(within(document.body).queryByRole("status")).toBeNull()
  })
})
