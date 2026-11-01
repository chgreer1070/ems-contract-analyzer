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
        facts: [
          {
            statement: "The payment term is 30 days.",
            operative: true,
            quote: "Payment is thirty (30) days.",
            documentName: "sample-msa.txt",
          },
        ],
        impacts: [
          {
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
  await expect(page.getByTestId("matter-reading-impact")).not.toContainText("USD");
});
