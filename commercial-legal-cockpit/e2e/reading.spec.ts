import { expect, test } from "@playwright/test";

test("the sample agreement page shows the Harborline reading", async ({ page }) => {
  await page.goto("/reading");
  await expect(page.getByTestId("operative-payment")).toContainText("60 days", { timeout: 20000 });
  await expect(page.getByTestId("citation")).toContainText("sixty (60)");
  await expect(page.getByTestId("replaced-payment")).toContainText("45 days");
  await expect(page.getByTestId("replaced-payment-citation")).toContainText("forty-five (45)");
  await expect(page.getByTestId("operative-ncnr")).toContainText("120 days");
  await expect(page.getByTestId("replaced-ncnr")).toContainText("90 days");
  await expect(page.getByTestId("notice-date")).toHaveText("2025-07-14");
  await expect(page.getByTestId("notice-kind")).toHaveText("inference");
  await expect(page.getByTestId("notice-citation")).toContainText("June 30, 2025");
  for (const area of ["margin", "cash", "working_capital", "inventory"]) {
    const impact = page.getByTestId(`impact-${area}`);
    await expect(impact).toContainText("cannot be determined");
    await expect(impact).not.toContainText("USD");
  }
  await expect(page.getByTestId("disclaimer")).toContainText("not a legal conclusion");

  await page.getByTestId("looked-at").click();
  await expect(page.getByTestId("review-note")).toHaveText(
    "A person looked at this sample. This is not an approval.",
  );
  await expect(page.getByTestId("operative-payment")).toContainText("60 days");
});

test("a matter opens the made-up sample reading and does not approve it", async ({ page }) => {
  const posts: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    posts.push(new URL(request.url()).pathname);
  });

  await page.goto("/matters/sample-matter");
  const matterPath = page.getByTestId("matter-sample-reading");
  await expect(matterPath).toContainText("Sample reading of a made-up agreement");
  await expect(matterPath).toContainText("not a Flex or customer contract");
  await expect(matterPath).toContainText("does not approve terms, send a notice, or change contract text");
  await expect(matterPath).toContainText("not an approval");
  await expect(matterPath.getByRole("link", { name: "Open the sample reading" })).toHaveAttribute("href", "/reading");

  await page.getByTestId("open-sample-reading").click();
  await expect(page).toHaveURL(/\/reading$/);
  await expect(page.getByTestId("sample-label")).toContainText("made-up agreement");
  await expect(page.getByTestId("disclaimer")).toContainText("not a legal conclusion", { timeout: 20000 });
  await expect(page.getByTestId("citation")).toContainText("sixty (60)");
  await expect(page.getByTestId("impact-margin")).toContainText("cannot be determined");
  await expect(page.getByRole("button", { name: "I looked at this sample." })).toBeVisible();
  await expect(page.getByRole("button", { name: /approve|send notice|change contract/i })).toHaveCount(0);

  await page.getByTestId("looked-at").click();
  await expect(page.getByTestId("review-note")).toHaveText(
    "A person looked at this sample. This is not an approval.",
  );
  expect(posts).toEqual(["/api/reading-sample"]);
});
