import { expect, test } from "@playwright/test";

// Subsidy Cliff and Split (PROJECT.md 22 AT 11, 12, 23; Phase 13).

test("the subsidy page states the cliff, the classes estimate and the window state", async ({ page }) => {
  await page.goto("/subsidy");
  await expect(page.getByText(/Rebate ends Sep(tember)? 29/).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Paid share \(est\.\)/)).toBeVisible();
  // The after window fills one day per daily sample (KL-34/KL-40); it may still be empty, partial or complete.
  await expect(page.getByText(/After window is incomplete: \d+ of 7 days|after window is empty|No block after Sep(tember)? 29/).first()).toBeVisible();
});

test("split states the two windows and the incomplete after window", async ({ page }) => {
  await page.goto("/lens/split");
  await expect(page.getByText("Before vs after")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/incomplete: \d+ of 7 days|No block after Sep(tember)? 29 is ingested yet/).first()).toBeVisible();
});
