import AxeBuilder from "@axe-core/playwright"
import { expect, test, type Page } from "@playwright/test"

async function openAgentsDestination(page: Page) {
  await page.goto("/agents")
  const appNavigation = page.getByRole("navigation", { name: "Application navigation" })
  const mobileNavigation = page.getByRole("navigation", { name: "Destinations" })
  if (await appNavigation.isVisible()) await expect(appNavigation.getByRole("link", { name: "Agents" })).toBeVisible()
  else await expect(mobileNavigation.getByRole("button", { name: "Agents" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible()
}

test("each viewport completes the standalone Agents operations workflow", async ({ page }, testInfo) => {
  await openAgentsDestination(page)

  const initialState = await page.evaluate(async () => {
    const response = await fetch("/__e2e/agents/status", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "qa", busy: false, queueDepth: 0 }),
    })
    return await response.json() as { restartCount: number }
  })
  await page.getByRole("searchbox", { name: "Search agents" }).fill("qa")
  await page.getByRole("button", { name: "Open qa" }).click()
  await expect(page.getByRole("heading", { name: "qa", exact: true })).toBeVisible()
  await expect(page.getByText("Idle", { exact: true }).first()).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.getByRole("tab", { name: "Configuration" }).click()
  const description = page.getByRole("textbox", { name: "Description" })
  const updatedDescription = `Quality gate operator ${testInfo.project.name}`
  await description.fill(updatedDescription)
  await page.getByRole("button", { name: "Advanced JSON" }).click()
  await expect(page.getByRole("textbox", { name: "Agent configuration JSON" })).toHaveValue(new RegExp(updatedDescription))
  await page.getByRole("button", { name: "Preview changes" }).click()
  await expect(page.getByRole("heading", { name: "Full hub restart required" })).toBeVisible()
  await page.getByRole("button", { name: "Save pending hub restart" }).click()
  await expect(page.getByText("qa configuration saved pending hub restart.", { exact: true })).toBeAttached()

  await page.getByRole("tab", { name: "Overview" }).click()
  await page.getByRole("button", { name: "Restart agent" }).click()
  const restart = page.getByRole("dialog", { name: "Restart agent" })
  await expect(restart.getByText("Agent is idle")).toBeVisible()
  await restart.getByRole("button", { name: "Restart agent" }).click()
  await expect(page.getByText("qa restart completed.", { exact: true })).toBeAttached()

  await page.evaluate(async () => {
    await fetch("/__e2e/agents/drop-stream", { method: "POST" })
  })
  const fixtureState = await page.evaluate(async () => {
    const response = await fetch("/__e2e/agents/status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "qa", busy: true, queueDepth: 2 }),
    })
    return await response.json() as { restartCount: number }
  })
  expect(fixtureState.restartCount).toBe(initialState.restartCount + 1)
  await expect(page.getByRole("region", { name: "Agent detail" }).getByText("Busy", { exact: true }).first()).toBeVisible()

  const axe = await new AxeBuilder({ page }).analyze()
  expect(axe.violations.filter(violation => violation.impact === "serious" || violation.impact === "critical")).toEqual([])

  await page.goto("/legacy")
  await expect(page.locator("body")).toContainText("Switchboard")
})
