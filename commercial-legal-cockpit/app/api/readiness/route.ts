import { accessErrorResponse, getPrincipal } from "@/lib/access";
import { getSystemReadiness } from "@/lib/readiness";
import { internalErrorResponse } from "@/lib/safeErrors";

export async function GET(request: Request) {
  try {
    const principal = await getPrincipal(request);
    if(principal.demo){
      return Response.json({
        ok:true,
        principal:{name:principal.name,role:principal.role,demo:true},
        readiness:{
          configured:{authenticationRequired:false,microsoftConfigured:false,databaseConfigured:false,privateBlobConfigured:false,malwareScannerConfigured:false,aiConfigured:false,ocrConfigured:false,legalRelianceEnabled:false},
          infrastructureReady:false,legalRelianceReady:false,persistentEvidenceQueried:false,validationPassed:false,standardsReady:false
        }
      });
    }
    const readiness = await getSystemReadiness({includePersistentEvidence:true});
    return Response.json({ ok:true, principal:{name:principal.name,role:principal.role,demo:principal.demo}, readiness });
  } catch (error) {
    const access=accessErrorResponse(error);if(access)return access;
    return internalErrorResponse(error,"System readiness could not be determined.");
  }
}
