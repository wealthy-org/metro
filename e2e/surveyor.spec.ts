import { expect, test } from "@playwright/test";

// Surveyor, end to end through the mocked OpenRouter (PROJECT.md 22 AT 17-22; Phase 13).
// The mock answers with a neutral, digit-free sentence, so the Phase 10 validator accepts it and no real model call
// or Redis counter is touched (Redis is emptied for the suite).

test("a question is answered with a model note and its sources", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto("/ask");
  const box = page.getByRole("textbox").first();
  await box.fill("What changed after the rebate ended?");
  await page.getByRole("button", { name: /^Ask/ }).click();
  // The note names the layer that answered (a free model id) or the Template.
  await expect(page.getByText(/:free|template|checked against \d+ facts/i).first()).toBeVisible({ timeout: 180_000 });
  await expect(page.getByRole("heading", { name: /Sources \(the facts/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/refus/i)).toHaveCount(0);
});
