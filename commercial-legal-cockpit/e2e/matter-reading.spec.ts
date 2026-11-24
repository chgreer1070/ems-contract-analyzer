import { expect, test } from "@playwright/test";

const matterId = "00000000-0000-4000-8000-000000000010";
const baseId = "00000000-0000-4000-8000-0000000000a1";
const wordId = "00000000-0000-4000-8000-0000000000a2";

test("a matter reads its own text and leaves Word files as evidence", async ({ page }) => {
  await page.route(`**/api/matters/${matterId}/documents`, (route) =>
    route.fulfill({
      json: {
        ok: true,
        mode: "database",
        documents: [
          {
            id: baseId,
            filename: "sample-msa.txt",
            document_type: "MSA",
            extraction_method: "PLAIN_TEXT",
            extraction_status: "EXTRACTED",
            integrity_status: "SERVER_VERIFIED",
            security_scan_status: "CLEAN",
            deletion_status: "ACTIVE",
            source_status: "DRAFT",
          },
          {
            id: wordId,
            filename: "redline.docx",
            document_type: "AMENDMENT",
            extraction_method: "DOCX_OOXML_EVIDENCE",
            extraction_status: "EXTRACTED",
            integrity_status: "SERVER_VERIFIED",
            security_scan_status: "CLEAN",
            deletion_status: "ACTIVE",
            source_status: "CURRENT",
          },
        ],
      },
    }),
  );
  await page.route(`**/api/matters/${matterId}/reading`, async (route) => {
    const body = route.request().postDataJSON() as { baseDocumentId?: string; amendmentDocumentIds?: string[] };
    expect(body.baseDocumentId).toBe(baseId);
    expect(body.amendmentDocumentIds).toEqual([]);
    await route.fulfill({
      json: {
        ok: true,
        relianceRecord: false,
        approval: false,
        disclaimer: "This is a reading aid. It is not a legal conclusion.",
        notes: ["sample-msa.txt is still a draft."],
        warnings: ["An amendment replacement could not be read."],
        operativeStatusUncertain: true,
        facts: [
          {
            id: "fact-1",
            kind: "fact",
            statement: "The payment term is 30 days.",
            operative: true,
            citations: [{ quote: "Payment is thirty (30) days.", originalFilename: "sample-msa.txt", section: "1.1", sourceDocumentId: baseId }],
          },
        ],
        impacts: [
          {
            kind: null,
            citations: [],
            source_fact_ids: [],
            domain: "pricing",
            area: "cash",
            summary: "The dollar effect cannot be determined.",
            amount: null,
            determination: "cannot_be_determined",
          },
        ],
      },
    });
  });

  await page.goto(`/matters/${matterId}`);
  await expect(page.getByTestId("matter-document-reading")).toContainText("not an approval");
  await expect(page.getByTestId("matter-document-reading")).toContainText("does not save this as a decision");
  await expect(page.getByTestId("word-evidence-note")).toContainText("redline.docx");
  await page.getByTestId("reading-base").selectOption(baseId);
  await page.getByTestId("read-documents").click();
  await expect(page.getByTestId("matter-reading-disclaimer")).toContainText("not a legal conclusion");
  await expect(page.getByTestId("matter-reading-quote")).toContainText("thirty (30) days");
  await expect(page.getByTestId("matter-reading-note")).toContainText("still a draft");
  await expect(page.getByTestId("matter-reading-impact")).toContainText("cannot be determined");
  await expect(page.getByTestId("matter-reading-warning")).toContainText("could not be read");
  await expect(page.getByTestId("matter-reading-fact")).toContainText("Contractual fact — current in this conditional reading; operative status requires review");
  await expect(page.getByTestId("matter-reading-fact")).not.toContainText("In force");
  await expect(page.getByTestId("matter-reading-impact")).not.toContainText("USD");
});

test("amendments are sent in selection order without a user-confirmed chronology", async ({ page }) => {
  const earlierId = "00000000-0000-4000-8000-0000000000b1";
  const laterId = "00000000-0000-4000-8000-0000000000b2";
  const documents = [[baseId, "Base", "MSA"], [laterId, "Later", "AMENDMENT"], [earlierId, "Earlier", "AMENDMENT"]].map(([id, filename, document_type]) => ({
    id, filename, document_type, extraction_method: "PLAIN_TEXT", extraction_status: "EXTRACTED", integrity_status: "SERVER_VERIFIED", security_scan_status: "CLEAN", deletion_status: "ACTIVE", source_status: "EXECUTED",
  }));
  const posts: Array<{ baseDocumentId?: string; amendmentDocumentIds?: string[]; amendmentOrderConfirmed?: boolean }> = [];
  await page.route(`**/api/matters/${matterId}/documents`, route => route.fulfill({ json: { ok: true, documents } }));
  await page.route(`**/api/matters/${matterId}/reading`, async route => {
    posts.push(route.request().postDataJSON());
    await route.fulfill({ json: {
      ok: true,
      relianceRecord: false,
      approval: false,
      disclaimer: "This is a reading aid. It is not a legal conclusion.",
      notes: [],
      warnings: [],
      operativeStatusUncertain: false,
      impacts: [],
      facts: [
        { id: "payment", kind: "fact", operative: true, statement: "The payment term is 30 days.", citations: [{ quote: "within thirty (30) days", originalFilename: "Later", section: "1.1", sourceDocumentId: laterId }] },
      ],
    } });
  });
  await page.goto(`/matters/${matterId}`);
  await page.getByTestId("reading-base").selectOption(baseId);
  await page.getByLabel("Later", { exact: true }).check();
  await page.getByLabel("Earlier", { exact: true }).check();
  await expect(page.getByTestId("reading-amendment-order")).toContainText("effective date written in each amendment");
  await expect(page.getByTestId("reading-amendment-order")).toContainText("ambiguous");
  await expect(page.getByRole("button", { name: "Move earlier" })).toHaveCount(0);
  await expect(page.getByLabel(/I have reviewed and confirm/)).toHaveCount(0);
  await expect(page.getByTestId("read-documents")).toBeEnabled();
  await page.getByTestId("read-documents").click();
  await expect(page.getByTestId("matter-reading-fact")).toContainText("The payment term is 30 days.");
  await page.getByTestId("matter-document-reading").screenshot({ path: "test-results/stated-date-reading.png" });
  await page.getByLabel("Later", { exact: true }).uncheck();
  await page.getByLabel("Earlier", { exact: true }).uncheck();
  await page.getByLabel("Earlier", { exact: true }).check();
  await page.getByLabel("Later", { exact: true }).check();
  await page.getByTestId("read-documents").click();
  await expect(page.getByTestId("matter-reading-fact")).toContainText("The payment term is 30 days.");
  expect(posts).toEqual([
    { baseDocumentId: baseId, amendmentDocumentIds: [laterId, earlierId] },
    { baseDocumentId: baseId, amendmentDocumentIds: [earlierId, laterId] },
  ]);
  expect(posts.every(post => post.amendmentOrderConfirmed === undefined)).toBe(true);
});

test("an undated amendment and a tied date are shown with the stated reason", async ({ page }) => {
  const undatedId = "00000000-0000-4000-8000-0000000000c1";
  const documents = [[baseId, "Base", "MSA"], [undatedId, "Undated", "AMENDMENT"]].map(([id, filename, document_type]) => ({
    id, filename, document_type, extraction_method: "PLAIN_TEXT", extraction_status: "EXTRACTED", integrity_status: "SERVER_VERIFIED", security_scan_status: "CLEAN", deletion_status: "ACTIVE", source_status: "EXECUTED",
  }));
  await page.route(`**/api/matters/${matterId}/documents`, route => route.fulfill({ json: { ok: true, documents } }));
  await page.route(`**/api/matters/${matterId}/reading`, async route => {
    await route.fulfill({
      status: 400,
      json: { ok: false, error: "Undated has no stated effective date, so it was not read. An amendment is ordered only by the effective date written in that amendment." },
    });
  });
  await page.goto(`/matters/${matterId}`);
  await page.getByTestId("reading-base").selectOption(baseId);
  await page.getByLabel("Undated", { exact: true }).check();
  await page.getByTestId("read-documents").click();
  await expect(page.getByTestId("matter-reading-error")).toContainText("no stated effective date");
  await page.route(`**/api/matters/${matterId}/reading`, async route => {
    await route.fulfill({
      status: 400,
      json: { ok: false, error: "Earlier and Later state the same effective date 2025-03-01, so their order is ambiguous and the reading stopped." },
    });
  });
  await page.getByTestId("read-documents").click();
  await expect(page.getByTestId("matter-reading-error")).toContainText("ambiguous");
  await expect(page.getByTestId("matter-reading-fact")).toHaveCount(0);
});
