export default function MatterSampleReadingLink() {
  return (
    <section
      data-testid="matter-sample-reading"
      style={{ maxWidth: 1600, margin: "18px auto 0", padding: "0 30px" }}
    >
      <div style={{ background: "white", border: "1px solid #e0e5ea", borderRadius: 12, padding: "14px 16px" }}>
        <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: ".12em", color: "#607080" }}>
          SAMPLE ONLY · NOT THIS MATTER
        </div>
        <h2 style={{ margin: "6px 0 8px", fontSize: 18 }}>Sample reading of a made-up agreement</h2>
        <p style={{ margin: "0 0 12px", color: "#3d4a55", fontSize: 14, lineHeight: 1.45 }}>
          Harborline is a made-up agreement. This reading is not this matter&apos;s contract, and it is not a Flex or customer contract.
          It is not a legal-reliance record. Opening it does not approve terms, send a notice, or change contract text.
          Marking that you looked at the sample is not an approval.
        </p>
        <a data-testid="open-sample-reading" href="/reading" style={{ fontWeight: 800, color: "#315f93" }}>
          Open the sample reading
        </a>
      </div>
    </section>
  );
}
