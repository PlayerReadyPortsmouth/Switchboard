import { expect, test } from "@playwright/test"

test.beforeEach(async ({ context }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "PWA installation behavior is viewport-independent")
  await context.setOffline(false)
})

test("manifest and generated icons expose installable metadata", async ({ page, request }) => {
  await page.goto("/")
  const manifestResponse = await request.get("/manifest.webmanifest")
  expect(manifestResponse.headers()["content-type"]).toContain("application/manifest+json")
  const manifest = await manifestResponse.json()
  expect(manifest).toMatchObject({
    id: "/", name: "Switchboard Workspace", short_name: "Switchboard", start_url: "/", scope: "/",
    display: "standalone", background_color: "#0b0f17", theme_color: "#121722",
  })
  for (const [path, size] of [["/icons/icon-192.png", 192], ["/icons/icon-512.png", 512], ["/icons/maskable-512.png", 512]] as const) {
    const response = await request.get(path)
    expect(response.ok()).toBe(true)
    expect(response.headers()["content-type"]).toContain("image/png")
    const dimensions = await page.evaluate(async ({ path }) => await new Promise<{ width: number; height: number }>((resolve, reject) => {
      const image = new Image()
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight })
      image.onerror = () => reject(new Error(`failed to load ${path}`))
      image.src = path
    }), { path })
    expect(dimensions).toEqual({ width: size, height: size })
  }
})

test("active service worker reloads a deep conversation URL with its draft while APIs fail", async ({ page, context }) => {
  await page.goto("/")
  await page.getByRole("button", { name: /Design review/ }).click()
  await page.getByRole("textbox", { name: "Message" }).fill("offline deep-link draft")
  await expect(page).toHaveURL(/\/conversations\//)
  await page.evaluate(async () => { await navigator.serviceWorker.ready })
  await page.reload()
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true)
  await context.setOffline(true)
  await page.reload()
  await expect(page).toHaveTitle("Switchboard")
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("offline deep-link draft")
  const apiFailed = await page.evaluate(async () => {
    try { await fetch("/api/conversations"); return false } catch { return true }
  })
  expect(apiFailed).toBe(true)
  await context.setOffline(false)
  await expect(page.getByRole("heading", { name: "Design review" })).toBeVisible()
  await page.getByRole("button", { name: "Conversation details" }).click()
  await expect(page.getByRole("combobox", { name: "Primary agent" })).toHaveValue("architect")
  await expect(page.getByRole("region", { name: "Conversation inspector" }).getByText("owner@example.com")).toHaveCount(2)
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("offline deep-link draft")
  await page.evaluate(async () => {
    await Promise.all((await navigator.serviceWorker.getRegistrations()).map(registration => registration.unregister()))
    await Promise.all((await caches.keys()).map(name => caches.delete(name)))
  })
})
