import { accessErrorResponse, getPrincipal } from "@/lib/access";
import { getSystemReadiness } from "@/lib/readiness";

export async function GET(request: Request) {
  try {
    const principal = await getPrincipal(request);
    const readiness = await getSystemReadiness();
    return Response.json({ ok:true, principal:{name:principal.name,role:principal.role,demo:principal.demo}, readiness });
  } catch (error) {
    const access=accessErrorResponse(error);if(access)return access;
    return Response.json({ok:false,error:error instanceof Error?error.message:"Unable to determine readiness."},{status:500});
  }
}
