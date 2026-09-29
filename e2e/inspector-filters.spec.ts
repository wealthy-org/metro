import { expect, test } from "@playwright/test";

// Inspector and the shared filters (PROJECT.md 22 AT 7, 9; Phase 13).

test("a building opens the Inspector with its numbers", async ({ page }) => {
  await page.goto("/lens/city");
  await page.getByRole("button", { name: /Contract call:.*Inspect/ }).first().click({ timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Contract call" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Numbers in this window")).toBeVisible();
});

test("the action filter lands in the URL and is restorable", async ({ page }) => {
  await page.goto("/lens/city");
  await expect(page.getByRole("group", { name: "View" })).toBeVisible();
  await page.getByLabel("Action", { exact: true }).selectOption("swap");
  await expect(page).toHaveURL(/action=swap/);
  // The same URL restores the same view.
  await page.reload();
  await expect(page.getByLabel("Action", { exact: true })).toHaveValue("swap");
});

test("the scope chip states the window and its size", async ({ page }) => {
  await page.goto("/lens/city");
  await expect(page.getByText(/tx,.*UTC|UTC ·/).first()).toBeVisible({ timeout: 20_000 });
});
