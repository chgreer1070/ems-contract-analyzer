import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth";
import { enforceMicrosoftAccountCutover } from "@/lib/microsoftAccountCutover";

const handler = toNextJsHandler(auth);

type AuthMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

async function dispatch(method: AuthMethod, request: Request) {
  switch (method) {
    case "GET":
      return handler.GET(request);
    case "POST":
      return handler.POST(request);
    case "PATCH":
      return handler.PATCH(request);
    case "PUT":
      return handler.PUT(request);
    case "DELETE":
      return handler.DELETE(request);
    default: {
      const unreachable: never = method;
      return unreachable;
    }
  }
}

async function withMicrosoftCutover(method: AuthMethod, request: Request) {
  const paused = await enforceMicrosoftAccountCutover();
  if (paused) return paused;
  return dispatch(method, request);
}

export function GET(request: Request) {
  return withMicrosoftCutover("GET", request);
}

export function POST(request: Request) {
  return withMicrosoftCutover("POST", request);
}

export function PATCH(request: Request) {
  return withMicrosoftCutover("PATCH", request);
}

export function PUT(request: Request) {
  return withMicrosoftCutover("PUT", request);
}

export function DELETE(request: Request) {
  return withMicrosoftCutover("DELETE", request);
}
