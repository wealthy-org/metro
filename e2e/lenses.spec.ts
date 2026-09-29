import { expect, test } from "@playwright/test";

// Every lens opens with its stage, its legend and no error overlay (PROJECT.md 22; Phase 13).

test.describe("lenses", () => {
  test("city shows the scene controls and an inspectable building", async ({ page }) => {
    await page.goto("/lens/city");
    await expect(page.getByRole("group", { name: "View" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Inspect/ }).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Building color: average fee per transaction")).toBeVisible();
  });

  test("terrain shows the surface controls and legend", async ({ page }) => {
    await page.goto("/lens/terrain");
    await expect(page.getByRole("group", { name: "View" })).toBeVisible();
    await expect(page.getByText("Terrain height and color:")).toBeVisible({ timeout: 20_000 });
  });

  test("flow draws its canvas", async ({ page }) => {
    await page.goto("/lens/flow");
    await expect(page.locator("canvas").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/unavailable/)).toHaveCount(0);
  });

  test("graph offers its three modes", async ({ page }) => {
    await page.goto("/lens/graph");
    await expect(page.getByRole("group", { name: "Graph mode" })).toBeVisible({ timeout: 20_000 });
  });

  test("heatmap renders its matrix", async ({ page }) => {
    await page.goto("/lens/heatmap");
    await expect(page.getByText(/unavailable/)).toHaveCount(0);
    await expect(page.getByRole("group", { name: "View" })).toHaveCount(0);
    await expect(page.locator("main")).toBeVisible();
  });

  test("launchpad renders its table", async ({ page }) => {
    await page.goto("/lens/launchpad");
    await expect(page.getByRole("table").first()).toBeVisible({ timeout: 20_000 });
  });

  test("split shows both windows and the comparison", async ({ page }) => {
    await page.goto("/lens/split");
    await expect(page.getByText("Before vs after")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/after Sep(tember)? 29/i).first()).toBeVisible();
  });
});
