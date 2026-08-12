export async function GET() {
  return Response.json({
    ok: true,
    service: "ems-commercial-legal-cockpit",
    version: "0.3.0",
    timestamp: new Date().toISOString()
  });
}
