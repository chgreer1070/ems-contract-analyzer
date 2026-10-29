"use client";

import { useEffect, useState } from "react";

type SampleReading = {
  disclaimer: string;
  payment: string;
  quote: string;
};

export default function ReadingPage() {
  const [reading, setReading] = useState<SampleReading | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  if (error) {
    return (
      <main data-testid="reading-error" style={{ fontFamily: "Georgia, serif", margin: "2rem", maxWidth: "40rem" }}>
        <h1>Sample agreement reading</h1>
        <p>{error}</p>
      </main>
    );
  }
  if (!reading) {
    return (
      <main data-testid="reading-loading" style={{ fontFamily: "Georgia, serif", margin: "2rem" }}>
        Reading the sample agreement.
      </main>
    );
  }
  return (
    <main style={{ fontFamily: "Georgia, serif", margin: "2rem", maxWidth: "40rem" }}>
      <h1>Sample agreement reading</h1>
      <p data-testid="disclaimer">{reading.disclaimer}</p>
      <p data-testid="operative-payment">{reading.payment}</p>
      <blockquote data-testid="citation">{reading.quote}</blockquote>
    </main>
  );
}
