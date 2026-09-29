import { expect, test } from "@playwright/test";

// Dispatch: the archive, a report page, its Markdown download and the builder (PROJECT.md 22 AT 24; Phase 13).

test("the archive lists reports and one opens with its Markdown", async ({ page }) => {
  await page.goto("/dispatch");
  await expect(page.getByRole("heading", { name: "Dispatch", level: 1 })).toBeVisible();
  const report = page.getByRole("link", { name: /daily-\d{4}-\d{2}-\d{2}|subsidy-impact|custom/ }).first();
  await expect(report).toBeVisible({ timeout: 20_000 });
  await report.click();
  await expect(page).toHaveURL(/\/dispatch\//);
  await expect(page.getByRole("heading", { name: /Metro Dispatch/ })).toBeVisible({ timeout: 20_000 });
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download Markdown" }).click()]);
  expect(download.suggestedFilename()).toMatch(/^metro-.*\.md$/);
});

test("the builder offers the range, the pictures and the sections", async ({ page }) => {
  await page.goto("/dispatch");
  await expect(page.getByLabel("Pictures")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Findings" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Build report" })).toBeVisible();
});
