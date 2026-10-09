import { test, expect } from "@playwright/test";

test("home page loads with the live dashboard", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Trading Panel" })).toBeVisible();
});

test("trading page loads with the command center", async ({ page }) => {
  await page.goto("/trading");
  await expect(
    page.getByRole("heading", { name: "Trading Dashboard" })
  ).toBeVisible();
});

test("portfolio page loads", async ({ page }) => {
  await page.goto("/portfolio");
  // Exact match — "Portfolio" is also a substring of the "Portfolio Value"
  // stat-card heading rendered further down the same page.
  await expect(
    page.getByRole("heading", { name: "Portfolio", exact: true })
  ).toBeVisible();
});

test("settings page loads", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
});

test("navbar links move between the redesigned pages", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Trading" }).click();
  await expect(page).toHaveURL(/\/trading$/);

  await page.getByRole("link", { name: "Portfolio" }).click();
  await expect(page).toHaveURL(/\/portfolio$/);

  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/settings$/);
});
