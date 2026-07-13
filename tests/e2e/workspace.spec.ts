import AxeBuilder from "@axe-core/playwright"
import { expect, test, type Page } from "@playwright/test"

async function openConversation(page: Page, title: string) {
  const mobileNavigation = page.getByRole("navigation", { name: "Mobile navigation" })
  if (await mobileNavigation.isVisible()) await mobileNavigation.getByRole("button", { name: "Conversations" }).click()
  await page.getByRole("button", { name: new RegExp(title, "i") }).click()
}

async function createConversation(page: Page, title: string) {
  await page.getByRole("button", { name: "New conversation" }).click()
  const dialog = page.getByRole("dialog", { name: "New conversation" })
  await dialog.getByRole("textbox", { name: "Title" }).fill(title)
  await dialog.getByRole("combobox", { name: "Primary agent" }).selectOption("architect")
  await dialog.getByRole("button", { name: "Create conversation" }).click()
  await expect(page.getByRole("heading", { name: title })).toBeVisible()
}

test("mobile uses one pane and preserves the draft across reload", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "This is the focused mobile draft workflow")
  await page.goto("/")
  await page.getByRole("button", { name: /Design review/ }).click()
  await page.getByRole("textbox", { name: "Message" }).fill("unsent")
  await page.reload()
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("unsent")
  await expect(page.getByRole("navigation", { name: "Mobile navigation" })).toBeVisible()
})

test("each viewport completes the durable web conversation workflow", async ({ page }, testInfo) => {
  const title = `Project workflow ${testInfo.project.name}`
  await page.goto("/")
  const identity = await page.evaluate(async () => {
    const response = await fetch("/api/session", { headers: { "X-Switchboard-User": "attacker@example.com" } })
    return await response.json() as { identity: string }
  })
  expect(identity.identity).toBe("owner@example.com")
  await createConversation(page, title)

  const composer = page.getByRole("textbox", { name: "Message" })
  await composer.fill("first turn")
  await composer.press("Enter")
  await expect(page.getByText("first turn", { exact: true })).toHaveCount(1)
  await expect(page.getByText("Fixture reply: first turn", { exact: true })).toHaveCount(1)
  await composer.fill("second turn")
  await page.getByRole("button", { name: "Send message" }).click()
  await expect(page.getByText("second turn", { exact: true })).toHaveCount(1)
  await expect(page.getByText("Fixture reply: second turn", { exact: true })).toHaveCount(1)

  await page.getByRole("button", { name: "Conversation details" }).click()
  await page.getByRole("combobox", { name: "Primary agent" }).selectOption("qa")
  await expect(page.getByRole("combobox", { name: "Primary agent" })).toHaveValue("qa")
  await page.getByRole("button", { name: "Close conversation details" }).click()

  const mobileNavigation = page.getByRole("navigation", { name: "Mobile navigation" })
  if (await mobileNavigation.isVisible()) await mobileNavigation.getByRole("button", { name: "Conversations" }).click()
  const search = page.getByRole("searchbox", { name: "Search conversations" })
  await search.fill(title)
  await expect(page.getByRole("button", { name: new RegExp(title) })).toBeVisible()
  await search.fill("")
  await openConversation(page, title)
  await page.getByRole("button", { name: "Archive conversation" }).click()
  const archive = page.getByRole("dialog", { name: "Archive conversation" })
  await archive.getByRole("button", { name: "Archive", exact: true }).click()
  await expect(page.getByRole("button", { name: new RegExp(title) })).toHaveCount(0)

  await page.goto("/legacy")
  await expect(page.locator("body")).toContainText("Switchboard")
})

test("responsive panes, drawers, touch targets, and overflow follow the project breakpoint", async ({ page }, testInfo) => {
  await page.goto("/")
  const conversationNavigation = page.getByRole("navigation", { name: "Conversation navigation" })
  const transcript = page.getByRole("region", { name: "Transcript" })
  const inspector = page.getByRole("region", { name: "Conversation inspector" })

  if (testInfo.project.name === "mobile") {
    await expect(conversationNavigation).toBeVisible()
    await expect(transcript).toBeHidden()
    await openConversation(page, "Design review")
    await expect(transcript).toBeVisible()
    await expect(conversationNavigation).toBeHidden()
    const mobileNavigation = page.getByRole("navigation", { name: "Mobile navigation" })
    await expect(mobileNavigation).toBeVisible()
    expect(await page.evaluate(() => navigator.maxTouchPoints)).toBeGreaterThan(0)
    const navigationBox = await mobileNavigation.boundingBox()
    expect(navigationBox).not.toBeNull()
    expect(navigationBox!.height).toBeGreaterThanOrEqual(64)
    expect(navigationBox!.y + navigationBox!.height).toBeLessThanOrEqual(844)
    for (const button of await mobileNavigation.getByRole("button").all()) {
      expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(48)
    }
    expect(await page.evaluate(() => [...document.styleSheets].some(sheet =>
      [...sheet.cssRules].some(rule => rule.cssText.includes("safe-area-inset-bottom")),
    ))).toBe(true)
    expect(await page.evaluate(() => ({
      body: document.body.scrollHeight <= window.innerHeight,
      document: document.documentElement.scrollHeight <= window.innerHeight,
    }))).toEqual({ body: true, document: true })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    return
  }

  await openConversation(page, "Design review")
  await expect(page.getByRole("navigation", { name: "Application navigation" })).toBeVisible()
  await expect(conversationNavigation).toBeVisible()
  await expect(transcript).toBeVisible()
  await expect(inspector).toBeHidden()
  const toggle = page.getByRole("button", { name: "Conversation details", exact: true })
  await toggle.click()
  await expect(inspector).toBeVisible()
  const close = page.getByRole("button", { name: "Close conversation details" })
  if (testInfo.project.name === "desktop") {
    const railBox = (await page.getByRole("navigation", { name: "Application navigation" }).boundingBox())!
    const listBox = (await conversationNavigation.boundingBox())!
    const transcriptOpenBox = (await transcript.boundingBox())!
    const inspectorBox = (await inspector.boundingBox())!
    expect(railBox.x + railBox.width).toBeLessThanOrEqual(listBox.x)
    expect(listBox.x + listBox.width).toBeLessThanOrEqual(transcriptOpenBox.x)
    expect(transcriptOpenBox.x + transcriptOpenBox.width).toBeLessThanOrEqual(inspectorBox.x)
    await close.click()
    await expect(inspector).toBeHidden()
    const transcriptClosedBox = (await transcript.boundingBox())!
    expect(transcriptClosedBox.width).toBeGreaterThan(transcriptOpenBox.width)
    return
  }
  if (testInfo.project.name === "tablet") await expect(close).toBeFocused()
  await close.click()
  await expect(inspector).toBeHidden()
  if (testInfo.project.name === "tablet") await expect(toggle).toBeFocused()
})

test("desktop contains the document and scrolls long history inside the transcript", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop grid containment is breakpoint-specific")
  await page.goto("/")
  await openConversation(page, "Long transcript")
  const composer = page.locator(".composer-shell")
  const composerBox = await composer.boundingBox()
  expect(composerBox).not.toBeNull()
  expect(composerBox!.y + composerBox!.height).toBeLessThanOrEqual(1000)
  expect(await page.evaluate(() => ({
    body: document.body.scrollHeight,
    document: document.documentElement.scrollHeight,
    viewport: window.innerHeight,
  }))).toEqual({ body: 1000, document: 1000, viewport: 1000 })

  const transcriptBody = page.locator(".transcript-body")
  const before = await transcriptBody.evaluate(element => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    scrollTop: element.scrollTop,
  }))
  expect(before.scrollHeight).toBeGreaterThan(before.clientHeight)
  expect(before.scrollTop).toBe(0)
  await transcriptBody.evaluate(element => { element.scrollTop = element.scrollHeight })
  expect(await transcriptBody.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
})

test("keyboard focus returns from dialogs and drawers, and composer honors Enter semantics", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "tablet", "Keyboard drawer behavior is exercised at the tablet breakpoint")
  await page.goto("/")
  const newConversation = page.getByRole("button", { name: "New conversation" })
  await newConversation.focus()
  await page.keyboard.press("Enter")
  const dialog = page.getByRole("dialog", { name: "New conversation" })
  const title = dialog.getByRole("textbox", { name: "Title" })
  const create = dialog.getByRole("button", { name: "Create conversation" })
  await expect(title).toBeFocused()
  await title.fill("Focus trap verification")
  await page.keyboard.press("Shift+Tab")
  expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true)
  await create.focus()
  await page.keyboard.press("Tab")
  expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true)
  await page.keyboard.press("Escape")
  await expect(newConversation).toBeFocused()

  await openConversation(page, "Design review")
  const details = page.getByRole("button", { name: "Conversation details", exact: true })
  await details.focus()
  await page.keyboard.press("Enter")
  const close = page.getByRole("button", { name: "Close conversation details" })
  await expect(close).toBeFocused()
  await page.keyboard.press("Shift+Tab")
  await expect(page.getByRole("combobox", { name: "Primary agent" })).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(close).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(details).toBeFocused()

  const composer = page.getByRole("textbox", { name: "Message" })
  await composer.fill("line one")
  await page.keyboard.press("Shift+Enter")
  await page.keyboard.type("line two")
  await expect(composer).toHaveValue("line one\nline two")
  await page.keyboard.press("Enter")
  await expect(page.getByText("line one\nline two", { exact: true })).toHaveCount(1)
})

test("open conversation modal and tablet inspector have no serious or critical Axe violations", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "tablet", "Overlay accessibility is exercised at the tablet drawer breakpoint")
  await page.goto("/")
  const newConversation = page.getByRole("button", { name: "New conversation" })
  await newConversation.click()
  const dialog = page.getByRole("dialog", { name: "New conversation" })
  await expect(dialog).toBeVisible()
  const modalResults = await new AxeBuilder({ page }).analyze()
  expect(modalResults.violations.filter(violation => violation.impact === "serious" || violation.impact === "critical")).toEqual([])
  await page.keyboard.press("Escape")
  await expect(newConversation).toBeFocused()

  await openConversation(page, "Design review")
  const details = page.getByRole("button", { name: "Conversation details", exact: true })
  await details.click()
  const inspector = page.getByRole("region", { name: "Conversation inspector" })
  await expect(inspector).toBeVisible()
  const drawerResults = await new AxeBuilder({ page }).analyze()
  expect(drawerResults.violations.filter(violation => violation.impact === "serious" || violation.impact === "critical")).toEqual([])
  await page.keyboard.press("Escape")
  await expect(details).toBeFocused()
})

test("conversation list and transcript have no serious or critical Axe violations", async ({ page }) => {
  await page.goto("/")
  const listResults = await new AxeBuilder({ page }).analyze()
  expect(listResults.violations.filter(violation => violation.impact === "serious" || violation.impact === "critical")).toEqual([])
  await openConversation(page, "Design review")
  const transcriptResults = await new AxeBuilder({ page }).analyze()
  expect(transcriptResults.violations.filter(violation => violation.impact === "serious" || violation.impact === "critical")).toEqual([])
})

test("commit then network failure retries the same key into one canonical message", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Canonical retry behavior is viewport-independent")
  await page.goto("/")
  await openConversation(page, "Design review")
  const keys: string[] = []
  let abortFirst = true
  await page.route("**/api/conversations/*/messages", async route => {
    if (route.request().method() !== "POST") return route.continue()
    keys.push(route.request().headers()["idempotency-key"] ?? "")
    if (abortFirst) {
      abortFirst = false
      await route.fetch()
      await route.abort("failed")
      return
    }
    await route.continue()
  })

  const content = "canonical retry payload"
  await page.getByRole("textbox", { name: "Message" }).fill(content)
  await page.getByRole("button", { name: "Send message" }).click()
  await expect(page.getByRole("button", { name: "Retry send" })).toBeVisible()
  await page.getByRole("button", { name: "Retry send" }).click()
  await expect(page.getByRole("button", { name: "Retry send" })).toBeHidden()
  expect(keys).toHaveLength(2)
  expect(keys[0]).toBeTruthy()
  expect(keys[1]).toBe(keys[0])
  await expect(page.getByText(content, { exact: true })).toHaveCount(1)
  await expect(page.getByText(`Fixture reply: ${content}`, { exact: true })).toHaveCount(1)
})

test("SSE drop recovers the committed gap once and in canonical order", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Reconnect behavior is viewport-independent")
  await page.goto("/")
  await openConversation(page, "Design review")
  const announcer = page.locator("[data-workspace-announcer]")
  await expect(announcer).toContainText("Live")
  const before = await page.locator(".message-item > p").allTextContents()
  const conversationId = decodeURIComponent(new URL(page.url()).pathname.split("/").at(-1) ?? "")
  const gap = "message committed during SSE gap"
  const status = await page.evaluate(async ({ conversationId, gap }) => {
    const response = await fetch("/__e2e/drop-and-commit", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId, content: gap }),
    })
    return response.status
  }, { conversationId, gap })
  expect(status).toBe(201)
  await expect(announcer).toContainText("Reconnecting")
  await expect(page.getByText(gap, { exact: true })).toHaveCount(1)
  await expect(announcer).toContainText("Live")
  const after = await page.locator(".message-item > p").allTextContents()
  expect(after.slice(0, before.length)).toEqual(before)
  expect(after.at(-1)).toBe(gap)
  expect(after.filter(item => item === gap)).toHaveLength(1)
})
