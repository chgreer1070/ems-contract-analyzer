import { expect, test } from "@playwright/test";

test("the sample agreement page shows the operative payment term and its quote", async ({ page }) => {
  await page.goto("/reading");
  await expect(page.getByTestId("operative-payment")).toContainText("60 days", { timeout: 20000 });
  await expect(page.getByTestId("citation")).toContainText("sixty (60)");
  await expect(page.getByTestId("disclaimer")).toContainText("not a legal conclusion");
});
