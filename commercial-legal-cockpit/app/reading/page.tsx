"use client";

import { useEffect, useState } from "react";

type SampleTerm = {
  statement: string;
  quote: string;
};

type SampleImpact = {
  area: "margin" | "cash" | "working_capital" | "inventory";
  summary: string;
  amount: string | null;
};

type SampleReading = {
  analysisId: string;
  disclaimer: string;
  payment: SampleTerm;
  replacedPayment: SampleTerm;
  ncnr: SampleTerm;
  replacedNcnr: SampleTerm;
  notice: {
    date: string | null;
    kind: string;
    description: string;
    quote: string;
  };
  impacts: SampleImpact[];
};

const impactLabel: Record<SampleImpact["area"], string> = {
  margin: "Margin",
  cash: "Cash",
  working_capital: "Working capital",
  inventory: "Inventory",
};

export default function ReadingPage() {
  const [reading, setReading] = useState<SampleReading | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviewNote, setReviewNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/reading-sample")
      .then(async (response) => {
        const body = (await response.json()) as SampleReading & { error?: string };
        if (!response.ok) {
          throw new Error(body.error || "The sample reading failed.");
        }
        if (!cancelled) setReading(body);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "The sample reading failed.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function markLookedAt() {
    if (!reading) return;
    const response = await fetch("/api/reading-sample", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ analysisId: reading.analysisId }),
    });
    const body = (await response.json()) as { message?: string; error?: string };
    if (!response.ok) {
      setError(body.error || "The sample could not be marked as looked at.");
      return;
    }
    setReviewNote(body.message ?? "A person looked at this sample. This is not an approval.");
  }

  const sampleLabel = (
    <p data-testid="sample-label">
      This is a sample reading of a made-up agreement. Harborline is not a Flex or customer contract.
      Looking at it is not an approval, and it does not send a notice or change contract text.
    </p>
  );
  if (error) {
    return (
      <main data-testid="reading-error" style={{ fontFamily: "Georgia, serif", margin: "2rem", maxWidth: "42rem" }}>
        <h1>Sample agreement reading</h1>
        {sampleLabel}
        <p>{error}</p>
      </main>
    );
  }
  if (!reading) {
    return (
      <main data-testid="reading-loading" style={{ fontFamily: "Georgia, serif", margin: "2rem", maxWidth: "42rem" }}>
        <h1>Sample agreement reading</h1>
        {sampleLabel}
        <p>Reading the sample agreement.</p>
      </main>
    );
  }
  return (
    <main style={{ fontFamily: "Georgia, serif", margin: "2rem", maxWidth: "42rem" }}>
      <h1>Sample agreement reading</h1>
      {sampleLabel}
      <p data-testid="disclaimer">{reading.disclaimer}</p>
      <h2>Payment</h2>
      <p data-testid="operative-payment">{reading.payment.statement}</p>
      <blockquote data-testid="citation">{reading.payment.quote}</blockquote>
      <p data-testid="replaced-payment">{reading.replacedPayment.statement}</p>
      <blockquote data-testid="replaced-payment-citation">{reading.replacedPayment.quote}</blockquote>
      <h2>Non-cancellable orders</h2>
      <p data-testid="operative-ncnr">{reading.ncnr.statement}</p>
      <p data-testid="replaced-ncnr">{reading.replacedNcnr.statement}</p>
      <h2>Notice</h2>
      <p data-testid="notice-date">{reading.notice.date}</p>
      <p data-testid="notice-kind">{reading.notice.kind}</p>
      <blockquote data-testid="notice-citation">{reading.notice.quote}</blockquote>
      <h2>Dollar impact</h2>
      <ul>
        {reading.impacts.map((impact) => (
          <li key={impact.area} data-testid={`impact-${impact.area}`}>
            {impactLabel[impact.area]}: {impact.summary}
            {impact.amount ? ` ${impact.amount}` : ""}
          </li>
        ))}
      </ul>
      <button type="button" data-testid="looked-at" onClick={() => void markLookedAt()}>
        I looked at this sample.
      </button>
      {reviewNote ? <p data-testid="review-note">{reviewNote}</p> : null}
    </main>
  );
}
