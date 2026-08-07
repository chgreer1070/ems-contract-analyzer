export async function GET() {
  return Response.json({
    ok: true,
    service: "ems-commercial-legal-cockpit",
    aiConfigured: Boolean(process.env.OPENAI_API_KEY),
    timestamp: new Date().toISOString()
  });
}
