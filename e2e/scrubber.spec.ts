import { expect, test } from "@playwright/test";

// The time scrubber (PROJECT.md 22 AT 10; Phase 13).

test("moving the thumb leaves live mode and Back to live returns", async ({ page }) => {
  await page.goto("/lens/city");
  const thumb = page.getByLabel("Point in time");
  await expect(thumb).toBeVisible({ timeout: 20_000 });
  await expect(thumb).toBeEnabled({ timeout: 20_000 });
  await thumb.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("button", { name: "Back to live" })).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Back to live" }).click();
  await expect(page.getByRole("button", { name: "Back to live" })).toHaveCount(0);
  await expect(page.getByText(/^Live ·/)).toBeVisible();
});

test("the replay controls are present", async ({ page }) => {
  await page.goto("/lens/terrain");
  await expect(page.getByRole("group", { name: "Replay speed" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: /Play history|Pause history/ })).toBeVisible();
});
