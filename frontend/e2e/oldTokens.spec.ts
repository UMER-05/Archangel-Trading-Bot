import { test, expect } from "@playwright/test";

test("Old Tokens dashboard loads and shows either results or an empty state", async ({
  page,
}) => {
  await page.goto("/trading/old-tokens");
  await expect(page.getByRole("heading", { name: "Old Tokens" })).toBeVisible();

  // The backing collection may genuinely be empty in a fresh environment —
  // assert on the mutually-exclusive real states, not a single one that
  // only holds when the DB happens to be pre-seeded.
  await expect(
    page.getByRole("table").or(page.getByText("No tokens match the current filters."))
  ).toBeVisible();
});
