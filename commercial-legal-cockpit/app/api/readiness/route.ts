import { accessErrorResponse, getPrincipal } from "@/lib/access";
import { authenticationRequired, isMicrosoftConfigured } from "@/lib/auth";
import { databaseConfigured } from "@/lib/db";

export async function GET(request: Request) {
  try {
    const principal = await getPrincipal(request);
    return Response.json({
      ok: true,
      principal: { name: principal.name, role: principal.role, demo: principal.demo },
      readiness: {
        authenticationRequired: authenticationRequired(),
        microsoftConfigured: isMicrosoftConfigured(),
        databaseConfigured: databaseConfigured(),
        privateBlobConfigured: Boolean(process.env.BLOB_READ_WRITE_TOKEN),
        aiConfigured: Boolean(process.env.OPENAI_API_KEY),
        legalRelianceEnabled: process.env.LEGAL_RELIANCE_ENABLED === "true"
      }
    });
  } catch (error) {
    const access = accessErrorResponse(error);
    if (access) return access;
    return Response.json({ ok: false, error: "Unable to determine readiness." }, { status: 500 });
  }
}
