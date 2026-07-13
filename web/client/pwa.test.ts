import "./testSetup"
import { afterEach, describe, expect, test } from "bun:test"
import { act, cleanup, render, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createElement } from "react"
import { InstallButton } from "./components/InstallButton"
import { App, type AppApi } from "./App"
import { isPwaRegistrationAllowed, registerPwa, type BeforeInstallPromptEvent } from "./pwa"

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

  test("drives the workspace banner and exact offline limitation copy", async () => {
    let listener: ((state: { installAvailable: boolean; online: boolean }) => void) | undefined
    const pwa = {
      state: () => ({ installAvailable: false, online: true }),
      subscribe: (next: typeof listener) => { listener = next; next?.(pwa.state()); return () => { listener = undefined } },
      install: async () => {},
    }
    const api: AppApi = {
      session: async () => ({ identity: "ada@example.com", agents: [{ name: "architect", alive: true, busy: false }] }),
      listConversations: async () => [],
      createConversation: async () => { throw new Error("not used") },
      archiveConversation: async () => { throw new Error("not used") },
    }
    render(createElement(App, { api, pwa }))
    await within(document.body).findByRole("heading", { name: "Switchboard" })

    act(() => listener?.({ installAvailable: false, online: false }))

    expect(document.querySelector(".connection-banner")?.getAttribute("data-state")).toBe("offline")
    expect(document.querySelector("[data-workspace-announcer]")?.textContent).toBe("Offline — drafts stay on this device. Messages are not submitted.")
  })

  test("reports an install prompt failure without leaving a dead install control", async () => {
    render(createElement(InstallButton, { available: true, onInstall: async () => { throw new Error("prompt failed") } }))
    await userEvent.click(within(document.body).getByRole("button", { name: "Install Switchboard" }))
    await waitFor(() => expect(within(document.body).getByRole("status").textContent).toBe("Switchboard could not be installed. Use your browser menu to try again."))
  })
})
