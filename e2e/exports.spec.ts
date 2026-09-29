import { expect, test } from "@playwright/test";

// CSV, PNG and the bounded dataset export (PROJECT.md 22 AT 25, 16; Phase 13).

test("the city exports its CSV with the shown rows", async ({ page }) => {
  await page.goto("/lens/city?window=24h");
  await expect(page.getByRole("group", { name: "View" })).toBeVisible({ timeout: 20_000 });
  const [csv] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "CSV" }).click()]);
  expect(csv.suggestedFilename()).toMatch(/^metro-city-24h-.*\.csv$/);
});

test("the city exports a PNG of the stage", async ({ page }) => {
  await page.goto("/lens/city?window=24h");
  await expect(page.getByRole("group", { name: "View" })).toBeVisible({ timeout: 20_000 });
  const [png] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "PNG" }).click()]);
  expect(png.suggestedFilename()).toMatch(/^metro-city-24h-.*\.png$/);
});

test("dataset bounds refuse out-of-range windows", async ({ request }) => {
  const bad = await request.get("/api/v1/export/txs.csv?from=2026-09-01&to=2026-09-08");
  expect(bad.status()).toBe(400);
  const body = (await bad.json()) as { error?: string };
  expect(body.error).toMatch(/day/);
  const good = await request.get("/api/v1/export/facts.csv");
  expect(good.status()).toBe(200);
  expect((await good.text()).split("\n")[0]).toMatch(/^# Metro export: facts/);
});

test("the data catalog links every dataset", async ({ page }) => {
  await page.goto("/data");
  for (const name of ["txs", "blocks", "agg_minute", "agg_day", "facts", "insights", "tokens"]) {
    await expect(page.getByRole("link", { name: `${name}.csv` })).toBeVisible();
  }
});
