import { Worker } from "node:worker_threads";
import { join } from "node:path";
import { PdfPreparationError, PDF_PREPARATION_MAX_BYTES, PDF_PREPARATION_MAX_PAGES, pdfBytesHash, type PdfPreparationRequest, type preparePdf } from "@/lib/pdfPreparation";

type PdfOutput = Awaited<ReturnType<typeof preparePdf>>;
type WorkerMessage = { ok?: boolean; error?: { message?: string; status?: number }; result?: PdfOutput };
type WorkerOptions = { filename: string; timeoutMs: number; concurrency: number };

/** Options are trusted server code only; no HTTP input can select worker code. */
export function createPdfPreparationRunner(options: WorkerOptions) {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || !Number.isSafeInteger(options.concurrency) || options.concurrency < 1) throw new Error("Invalid PDF worker limits.");
  let active = 0;
  return async (operation: PdfPreparationRequest, inputs: Uint8Array[]): Promise<PdfOutput> => {
    if (active >= options.concurrency) throw new PdfPreparationError("PDF preparation capacity is busy; try again later.", 429);
    if (inputs.reduce((size, bytes) => size + bytes.length, 0) > PDF_PREPARATION_MAX_BYTES) throw new PdfPreparationError("Combined source bytes exceed 25 MiB.");
    active++;
    let worker: Worker | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Copy into dedicated buffers so transfer never detaches authoritative input.
      const copies = inputs.map(bytes => Uint8Array.from(bytes));
      worker = new Worker(options.filename, {
        workerData: { operation, inputs: copies }, transferList: copies.map(bytes => bytes.buffer),
        env: {}, execArgv: [],
        resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 }
      });
      const message = await new Promise<WorkerMessage>((resolve, reject) => {
        timer = setTimeout(() => reject(new PdfPreparationError("PDF preparation worker timed out.", 408)), options.timeoutMs);
        worker!.once("message", resolve);
        worker!.once("messageerror", () => reject(new PdfPreparationError("PDF preparation worker returned invalid data.", 500)));
        worker!.once("error", () => reject(new PdfPreparationError("PDF preparation worker failed.", 500)));
        worker!.once("exit", () => reject(new PdfPreparationError("PDF preparation worker exited without a result.", 500)));
      });
      if (message?.ok === false && typeof message.error?.message === "string" && [400, 409, 500].includes(message.error.status ?? 0)) throw new PdfPreparationError(message.error.message, message.error.status);
      const output = message?.result;
      if (message?.ok !== true || !(output?.bytes instanceof Uint8Array) || output.bytes.length < 5 ||
          output.bytes.length > PDF_PREPARATION_MAX_BYTES || Buffer.from(output.bytes.subarray(0, 5)).toString() !== "%PDF-" ||
          !Number.isSafeInteger(output.pageCount) || output.pageCount < 1 || output.pageCount > PDF_PREPARATION_MAX_PAGES ||
          !Array.isArray(output.pageMap) || output.pageMap.length !== output.pageCount ||
          output.pageMap.some((page, index) => page?.outputPage !== index + 1 || !operation.documentIds.includes(page.sourceDocumentId) || !Number.isSafeInteger(page.sourcePage) || page.sourcePage < 1 || page.sourcePage > PDF_PREPARATION_MAX_PAGES) ||
          pdfBytesHash(output.bytes) !== output.sha256) {
        throw new PdfPreparationError("PDF preparation worker returned invalid data.", 500);
      }
      return { bytes: output.bytes, sha256: output.sha256, pageCount: output.pageCount, pageMap: output.pageMap };
    } finally {
      if (timer) clearTimeout(timer);
      // Keep the capacity slot until the thread has actually stopped.
      try { if (worker) await worker.terminate(); } finally { active--; }
    }
  };
}

export const preparePdfInWorker = createPdfPreparationRunner({
  filename: join(process.cwd(), "runtime", "pdfPreparationWorker.cjs"), timeoutMs: 15_000, concurrency: 2
});
