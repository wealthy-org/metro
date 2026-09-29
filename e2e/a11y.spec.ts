import { expect, test } from "@playwright/test";

// Accessibility and resilience (PROJECT.md 22 AT 26, 27, 28; Phase 13): keys 1 to 7, the narrow-screen guard,
// reduced motion, the no-WebGL fallback, the development-only stress page and a clean console.

test("keys 1 to 7 switch lenses and never hijack a field", async ({ page }) => {
  await page.goto("/lens/city");
  await expect(page.getByRole("group", { name: "View" })).toBeVisible({ timeout: 20_000 });
  await page.keyboard.press("4");
  await expect(page).toHaveURL(/\/lens\/graph/, { timeout: 15_000 });
  await page.getByLabel("Window").focus();
  await page.keyboard.press("5");
  await page.waitForTimeout(600);
  await expect(page).toHaveURL(/\/lens\/graph/);
});

test("below 1280 px the width message shows", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.goto("/lens/city");
  await expect(page.getByText("Open Metro on a wider screen")).toBeVisible();
  await page.goto("/data");
  await expect(page.getByText("Open Metro on a wider screen")).toBeVisible();
});

test("reduced motion leaves the vehicles out", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/lens/city");
  await expect(page.getByRole("group", { name: "View" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/Vehicles: the/)).toHaveCount(0);
});

test("without WebGL the city shows its bars with a clear message", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  await context.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
      if (String(type).includes("webgl")) return null;
      return original.call(this, type as never, ...(rest as never[]));
    } as typeof HTMLCanvasElement.prototype.getContext;
  });
  const page = await context.newPage();
  await page.goto("/lens/city");
  await expect(page.getByText("3D is unavailable in this browser")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("list", { name: /City lens as bars/ })).toBeVisible();
  await context.close();
});

test("the stress page is development-only", async ({ request }) => {
  const res = await request.get("/dev/stress");
  expect(res.status()).toBe(404);
});

test("no console errors across the main pages", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`${msg.text()} @ ${page.url()}`);
  });
  page.on("pageerror", (err) => errors.push(`${err.message} @ ${page.url()}`));
  for (const path of ["/", "/lens/city", "/lens/terrain", "/lens/graph", "/data", "/api", "/dispatch", "/subsidy", "/insights", "/methodology", "/ask"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle").catch(() => {});
  }
  expect(errors).toEqual([]);
});
