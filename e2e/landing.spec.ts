import { expect, test } from "@playwright/test";

test("landing anchors and interactive sections work with pointer and keyboard", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await expect(page.locator("#why p span").first()).toHaveCSS("opacity", "1");
  await expect.poll(() => page.locator(".tilt-card").first().evaluate((element) => getComputedStyle(element).transform)).toBe("none");

  const nav = page.getByRole("navigation", { name: "Main" });
  await nav.getByRole("link", { name: "Questions" }).click();
  await expect(page).toHaveURL(/#faq$/);
  await expect(page.getByRole("heading", { name: "Before you open it." })).toBeInViewport();

  const faqItem = page.locator("#faq details").first();
  await faqItem.locator("summary").click();
  await expect(faqItem).toHaveAttribute("open", "");
  await expect(faqItem.locator("p")).toContainText("Nothing on this page is sample data.");

  await nav.getByRole("link", { name: "Subsidy Cliff" }).click();
  const subsidyRow = page.locator("#subsidy li").first();
  const subsidyBefore = await subsidyRow.evaluate((element) => getComputedStyle(element).backgroundColor);
  await subsidyRow.hover();
  await expect.poll(() => subsidyRow.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(subsidyBefore);
  await nav.getByRole("link", { name: "Traceable numbers" }).click();
  const traceItem = page.locator("#trace ol li").first();
  const traceBefore = await traceItem.evaluate((element) => getComputedStyle(element).backgroundColor);
  await traceItem.hover();
  await expect.poll(() => traceItem.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(traceBefore);
  const methodCard = page.getByRole("heading", { name: "Predict prices" }).locator("..");
  const methodBefore = await methodCard.evaluate((element) => getComputedStyle(element).backgroundColor);
  await methodCard.hover();
  await expect.poll(() => methodCard.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(methodBefore);

  await nav.getByRole("link", { name: "Surveyor" }).click();
  const stepHeadings = ["Facts are computed", "Surveyor writes", "Every number is matched", "Answer with sources"];
  const surveyorPanel = page.getByRole("group", { name: "How Surveyor answers" }).getByRole("tabpanel");
  for (const [index, heading] of stepHeadings.entries()) {
    await page.locator(`#surveyor-step-${index}`).click();
    await expect(surveyorPanel.getByRole("heading", { name: heading })).toBeVisible();
  }
  await expect(page.locator("#surveyor-step-2")).toHaveCSS("min-height", "44px");
  await page.locator("#surveyor-step-2").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#surveyor-step-3")).toBeFocused();

  await nav.getByRole("link", { name: "Lenses" }).click();
  const lenses = [
    ["City", "city"],
    ["Terrain", "terrain"],
    ["Flow", "flow"],
    ["Graph", "graph"],
    ["Heatmap", "heatmap"],
    ["Launchpad", "launchpad"],
    ["Split", "split"],
  ];
  for (const [index, [name, key]] of lenses.entries()) {
    const tab = page.getByRole("tablist", { name: "Lenses" }).getByRole("tab").nth(index);
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("link", { name: `Open the ${name} lens` })).toHaveAttribute("href", `/lens/${key}`);
  }
  const cityTab = page.locator("#landing-lens-tab-city");
  const terrainTab = page.locator("#landing-lens-tab-terrain");
  await cityTab.focus();
  await page.keyboard.press("ArrowRight");
  await expect(terrainTab).toBeFocused();
  await expect(terrainTab).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowLeft");
  await expect(cityTab).toBeFocused();
  const expand = page.getByRole("button", { name: "Expand" });
  await expand.click();
  const dialog = page.getByRole("dialog", { name: "City panel, expanded" });
  await expect(dialog).toBeVisible();
  const close = dialog.getByRole("button", { name: "Close" });
  const lensLink = dialog.getByRole("link", { name: "Open the City lens" });
  await expect(close).toBeFocused();
  await expect(close).toHaveCSS("min-height", "44px");
  await page.keyboard.press("Tab");
  await expect(lensLink).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(lensLink).toBeFocused();
  await expect(page.locator("body")).toHaveCSS("overflow", "hidden");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(expand).toBeFocused();
  await expect(page.locator("body")).not.toHaveCSS("overflow", "hidden");
});

test("landing text and sections reflow without horizontal overflow on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "The chain, seen as a city" })).toBeVisible();
  const geometry = await page.evaluate(() => {
    const viewport = document.documentElement.clientWidth;
    const offenders = [...document.querySelectorAll("body *")]
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return { tag: element.tagName, className: element.getAttribute("class"), left: rect.left, right: rect.right, width: rect.width };
      })
      .filter((element) => element.width > 0 && (element.left < -1 || element.right > viewport + 1))
      .sort((left, right) => right.right - left.right)
      .slice(0, 8);
    return { viewport, page: document.documentElement.scrollWidth, offenders };
  });
  expect(geometry.page, JSON.stringify(geometry.offenders)).toBeLessThanOrEqual(geometry.viewport);
  await expect(page.locator("#why p").first()).toContainText("An explorer lists transactions");
  await expect(page.getByRole("heading", { name: "What Metro will not do." })).toBeAttached();
});
