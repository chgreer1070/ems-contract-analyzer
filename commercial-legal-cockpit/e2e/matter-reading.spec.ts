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

test("amendments require explicit ordered confirmation and reset it after changes", async ({ page }) => {
  const earlierId = "00000000-0000-4000-8000-0000000000b1";
  const laterId = "00000000-0000-4000-8000-0000000000b2";
  const documents = [[baseId, "Base", "MSA"], [laterId, "Later", "AMENDMENT"], [earlierId, "Earlier", "AMENDMENT"]].map(([id, filename, document_type]) => ({
    id, filename, document_type, extraction_method: "PLAIN_TEXT", extraction_status: "EXTRACTED", integrity_status: "SERVER_VERIFIED", security_scan_status: "CLEAN", deletion_status: "ACTIVE", source_status: "EXECUTED",
  }));
  await page.route(`**/api/matters/${matterId}/documents`, route => route.fulfill({ json: { ok: true, documents } }));
  await page.route(`**/api/matters/${matterId}/reading`, async route => {
    expect(route.request().postDataJSON()).toEqual({ baseDocumentId: baseId, amendmentDocumentIds: [earlierId, laterId], amendmentOrderConfirmed: true });
    await route.fulfill({ json: { disclaimer: "Conditional reading", notes: [], warnings: ["Order is not independently verified."], operativeStatusUncertain: true, impacts: [], facts: [
      { id: "inference", kind: "inference", operative: true, statement: "Calculated notice deadline", citations: [] },
      { id: "assumption", kind: "assumption", operative: true, statement: "February 28 convention", citations: [] },
    ] } });
  });
  await page.goto(`/matters/${matterId}`);
  await page.getByTestId("reading-base").selectOption(baseId);
  await page.getByLabel("Later", { exact: true }).check();
  await page.getByLabel("Earlier", { exact: true }).check();
  await expect(page.getByTestId("read-documents")).toBeDisabled();
  await page.getByRole("button", { name: "Move earlier" }).nth(1).click();
  const confirmation = page.getByLabel(/I have reviewed and confirm/);
  await confirmation.check();
  await page.getByTestId("read-documents").click();
  await expect(page.getByTestId("matter-reading-fact").nth(0)).toContainText("Calculated inference — current in this conditional reading; operative status requires review");
  await expect(page.getByTestId("matter-reading-fact").nth(1)).toContainText("Assumption — current in this conditional reading; operative status requires review");
  await page.getByRole("button", { name: "Move earlier" }).nth(1).click();
  await expect(confirmation).not.toBeChecked();
  await expect(page.getByTestId("read-documents")).toBeDisabled();
  await expect(page.getByTestId("matter-reading-fact")).toHaveCount(0);
});
