"use client";

import { useEffect, useState } from "react";
import { readingFactLabel } from "@/lib/matterDocumentReading.mjs";

type StoredDocument = {
  id: string;
  filename: string;
  document_type: string;
  extraction_method: string | null;
  extraction_status: string;
  integrity_status: string;
  security_scan_status: string;
  deletion_status: string;
  source_status: string;
};

type ReadingFact = {
  statement: string;
  operative: boolean;
  id: string;
  kind: "fact" | "inference" | "assumption";
  citations: Array<{ quote: string; originalFilename: string; section: string | null; sourceDocumentId: string | null }>;
};

type ReadingImpact = {
  kind: "fact" | "inference" | "assumption" | null;
  citations: ReadingFact["citations"];
  source_fact_ids: string[];
  domain: string;
  area: string;
  summary: string;
  amount: string | null;
  determination: "supported" | "cannot_be_determined";
};

type ReadingResponse = {
  disclaimer: string;
  notes: string[];
  warnings: string[];
  operativeStatusUncertain: boolean;
  facts: ReadingFact[];
  impacts: ReadingImpact[];
};

const box = {
  background: "white",
  border: "1px solid #e0e5ea",
  borderRadius: 12,
  padding: "14px 16px",
} as const;

function canRead(document: StoredDocument) {
  return (
    document.deletion_status === "ACTIVE" &&
    document.security_scan_status === "CLEAN" &&
    document.integrity_status === "SERVER_VERIFIED" &&
    document.extraction_status === "EXTRACTED" &&
    (document.extraction_method === "PLAIN_TEXT" || document.extraction_method === "PDF_TEXT")
  );
}

function impactLine(impact: ReadingImpact): string {
  switch (impact.determination) {
    case "supported":
      return impact.amount ? `${impact.summary} ${impact.amount}` : impact.summary;
    case "cannot_be_determined":
      return impact.summary;
    default: {
      const unexpected: never = impact.determination;
      return unexpected;
    }
  }
}

export default function MatterDocumentReading({ matterId }: { matterId: string }) {
  // A matter change must discard selections, confirmations and in-flight response state.
  return <MatterDocumentReadingForMatter key={matterId} matterId={matterId} />;
}

function MatterDocumentReadingForMatter({ matterId }: { matterId: string }) {
  const [documents, setDocuments] = useState<StoredDocument[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [baseId, setBaseId] = useState("");
  const [amendmentIds, setAmendmentIds] = useState<string[]>([]);
  const [orderConfirmed, setOrderConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState<ReadingResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/matters/${matterId}/documents`, { cache: "no-store" })
      .then(async (response) => {
        const body = (await response.json()) as { error?: string; documents?: StoredDocument[] };
        if (!response.ok) throw new Error(body.error || "The matter documents could not be loaded.");
        if (!cancelled) setDocuments(body.documents ?? []);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "The matter documents could not be loaded.");
      });
    return () => {
      cancelled = true;
    };
  }, [matterId]);

  const readable = (documents ?? []).filter(canRead);
  const bases = readable.filter((document) => document.document_type !== "AMENDMENT");
  const amendments = readable.filter((document) => document.document_type === "AMENDMENT");
  const wordFiles = (documents ?? []).filter((document) => document.extraction_method === "DOCX_OOXML_EVIDENCE");

  async function readDocuments() {
    setBusy(true);
    setError(null);
    setReading(null);
    try {
      const response = await fetch(`/api/matters/${matterId}/reading`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseDocumentId: baseId, amendmentDocumentIds: amendmentIds, amendmentOrderConfirmed: orderConfirmed }),
      });
      const body = (await response.json()) as ReadingResponse & { error?: string };
      if (!response.ok) throw new Error(body.error || "The matter reading could not be completed.");
      setReading(body);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "The matter reading could not be completed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section data-testid="matter-document-reading" style={{ maxWidth: 1600, margin: "18px auto 0", padding: "0 30px" }}>
      <div style={box}>
        <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: ".12em", color: "#607080" }}>
          THIS MATTER · NOT AN APPROVAL
        </div>
        <h2 style={{ margin: "6px 0 8px", fontSize: 18 }}>Read this matter&apos;s documents</h2>
        <p style={{ margin: "0 0 12px", color: "#3d4a55", fontSize: 14, lineHeight: 1.45 }}>
          This reads the extracted text of files stored on this matter. It is not an approval, it does not send a notice,
          and it does not change contract text. The cockpit does not save this as a decision. Negotiated Word files stay
          evidence and are not read as the agreement.
        </p>
        {documents === null && !error ? <p>Loading this matter&apos;s documents.</p> : null}
        {error ? <p data-testid="matter-reading-error">{error}</p> : null}
        {documents && bases.length === 0 ? (
          <p>This matter has no plain-text or PDF agreement ready to read.</p>
        ) : null}
        {bases.length > 0 ? (
          <div style={{ display: "grid", gap: 10 }}>
            <label style={{ fontSize: 13, fontWeight: 700 }}>
              Base agreement
              <select
                data-testid="reading-base"
                disabled={busy}
                value={baseId}
                onChange={(event) => { setBaseId(event.target.value); setReading(null); setOrderConfirmed(false); }}
                style={{ display: "block", marginTop: 4, padding: 8, maxWidth: 480 }}
              >
                <option value="">Choose a document</option>
                {bases.map((document) => (
                  <option key={document.id} value={document.id}>
                    {document.filename} ({document.document_type}, {document.source_status})
                  </option>
                ))}
              </select>
            </label>
            {amendments.length > 0 ? (
              <fieldset data-testid="reading-amendments" style={{ border: "1px solid #e0e5ea", borderRadius: 8 }}>
                <legend style={{ fontSize: 13, fontWeight: 700 }}>Amendments</legend>
                {amendments.map((document) => (
                  <label key={document.id} style={{ display: "block", fontSize: 13 }}>
                    <input
                      type="checkbox"
                      disabled={busy}
                      checked={amendmentIds.includes(document.id)}
                      onChange={(event) => {
                        setOrderConfirmed(false);
                        setReading(null);
                        setAmendmentIds((current) =>
                          event.target.checked ? [...current, document.id] : current.filter((id) => id !== document.id),
                        );
                      }}
                    />{" "}
                    {document.filename}
                  </label>
                ))}
              </fieldset>
            ) : null}
            {amendmentIds.length > 0 ? (
              <div>
                <p>Amendment order, earliest to latest. Review the documents and move each amendment into the intended order. Checkbox selection order does not establish chronology.</p>
                <ol>
                  {amendmentIds.map((id, index) => (
                    <li key={id}>
                      {amendments.find(document => document.id === id)?.filename}
                      <button type="button" disabled={index === 0 || busy} onClick={() => {
                        setAmendmentIds(current => {
                          const next = [...current];
                          [next[index - 1], next[index]] = [next[index], next[index - 1]];
                          return next;
                        });
                        setOrderConfirmed(false);
                        setReading(null);
                      }}>Move earlier</button>
                    </li>
                  ))}
                </ol>
                <label><input type="checkbox" disabled={busy} checked={orderConfirmed} onChange={event => { setOrderConfirmed(event.target.checked); setReading(null); }} /> I have reviewed and confirm this earliest-to-latest order. The reading is conditional on this order, not independently verified effective dates.</label>
              </div>
            ) : null}
            <button
              type="button"
              data-testid="read-documents"
              disabled={!baseId || busy || (amendmentIds.length > 0 && !orderConfirmed)}
              onClick={() => void readDocuments()}
              style={{ justifySelf: "start", padding: "9px 13px", border: 0, borderRadius: 8, background: "#17212b", color: "white", fontWeight: 800 }}
            >
              {busy ? "Reading…" : "Read these documents"}
            </button>
          </div>
        ) : null}
        {wordFiles.length > 0 ? (
          <p data-testid="word-evidence-note" style={{ fontSize: 13, color: "#3d4a55" }}>
            Kept as evidence, not read as the agreement: {wordFiles.map((document) => document.filename).join(", ")}.
          </p>
        ) : null}
        {reading ? (
          <div style={{ marginTop: 14 }}>
            <p data-testid="matter-reading-disclaimer">{reading.disclaimer}</p>
            {reading.notes.map((note) => (
              <p key={note} data-testid="matter-reading-note">{note}</p>
            ))}
            {reading.warnings.map((warning, index) => <p role="alert" key={index} data-testid="matter-reading-warning">{warning}</p>)}
            <ul>
              {reading.facts.map((fact) => (
                <li key={fact.id} data-testid="matter-reading-fact">
                  {readingFactLabel(fact, reading.operativeStatusUncertain)}
                  {fact.statement}
                  {fact.citations.map((citation, index) => (
                    <blockquote key={index} data-testid="matter-reading-quote">
                      {citation.quote}
                      <footer>{citation.originalFilename}{citation.section ? ` · Section ${citation.section}` : ""}{citation.sourceDocumentId ? ` · Source ${citation.sourceDocumentId}` : ""}</footer>
                    </blockquote>
                  ))}
                </li>
              ))}
            </ul>
            <ul>
              {reading.impacts.map((impact) => (
                <li key={`${impact.domain}-${impact.area}`} data-testid="matter-reading-impact">
                  {impact.kind ? { fact: "Contractual fact", inference: "Calculated inference", assumption: "Assumption" }[impact.kind] : "Not determined"} — {impact.area}: {impactLine(impact)}
                  {impact.citations.map((citation, index) => (
                    <blockquote key={index}>
                      {citation.quote}
                      <footer>{citation.originalFilename}{citation.section ? ` · Section ${citation.section}` : ""}{citation.sourceDocumentId ? ` · Source ${citation.sourceDocumentId}` : ""}</footer>
                    </blockquote>
                  ))}
                  {impact.source_fact_ids.length > 0 ? <small>Source statements: {impact.source_fact_ids.join(", ")}</small> : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  );
}
