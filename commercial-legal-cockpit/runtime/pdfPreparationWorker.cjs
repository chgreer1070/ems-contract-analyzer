"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const { preparePdf, PdfPreparationError } = require("./pdfPreparationEngine.cjs");

// Only document bytes and the operation arrive here. Provider credentials and
// provider writes stay in the parent request after worker completion.
(async () => {
  try {
    const result = await preparePdf(workerData.operation, workerData.inputs);
    parentPort.postMessage({ ok: true, result }, [result.bytes.buffer]);
  } catch (error) {
    parentPort.postMessage({ ok: false, error: error instanceof PdfPreparationError
      ? { message: error.message, status: error.status }
      : { message: "PDF preparation worker failed.", status: 500 } });
  } finally { parentPort.close(); }
})();
