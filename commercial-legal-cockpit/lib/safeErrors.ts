type ErrorWithCode = { code?: unknown };

function safeIdentifier(value:unknown,fallback:string) {
  const candidate=typeof value==="string"||typeof value==="number"?String(value):"";
  return /^[A-Za-z0-9_.:-]{1,64}$/u.test(candidate)?candidate:fallback;
}

export function safeErrorCode(error:unknown) {
  try {
    return safeIdentifier(
      typeof error==="object"&&error!==null?(error as ErrorWithCode).code:undefined,
      "UNCLASSIFIED"
    );
  } catch {
    return "UNCLASSIFIED";
  }
}

function safeErrorClass(error:unknown) {
  try {
    if(error instanceof Error)return safeIdentifier(error.name,"Error");
    return safeIdentifier(typeof error,"UnknownError");
  } catch {
    return "UnknownError";
  }
}

export function recordInternalError(error:unknown) {
  const correlationId=globalThis.crypto.randomUUID();
  const errorClass=safeErrorClass(error);
  const errorCode=safeErrorCode(error);
  // Deliberately exclude message, stack, SQL, provider payloads, request data,
  // parameters, and source text from the application log boundary.
  console.error(JSON.stringify({event:"internal_request_error",correlationId,errorClass,errorCode}));
  return {correlationId,errorClass,errorCode};
}

export function safeOperationalFailure(error:unknown,publicMessage:string) {
  const {correlationId}=recordInternalError(error);
  return {correlationId,message:`${publicMessage} Reference: ${correlationId}.`};
}

export function safePersistedFailureForDisplay(value:unknown,publicMessage="Processing failed.") {
  const candidate=typeof value==="string"?value:"";
  const match=/Reference: ([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.$/iu.exec(candidate);
  return match?`${publicMessage} Reference: ${match[1]}.`:publicMessage;
}

export function internalErrorResponse(
  error:unknown,
  publicMessage="The request could not be completed.",
  status:500|502=500
) {
  const {correlationId}=recordInternalError(error);
  return Response.json(
    {ok:false,error:publicMessage,correlationId},
    {
      status,
      headers:{
        "Cache-Control":"no-store, max-age=0",
        "Pragma":"no-cache",
        "X-Correlation-ID":correlationId
      }
    }
  );
}
