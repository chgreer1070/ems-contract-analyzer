import { getSessionCookie } from "better-auth/cookies";
import { NextRequest, NextResponse } from "next/server";

const PUBLIC_EXACT_PATHS = new Set(["/sign-in", "/api/health", "/api/health/release"]);

function isPublicPath(pathname:string){
  return PUBLIC_EXACT_PATHS.has(pathname)||pathname==="/api/auth"||pathname.startsWith("/api/auth/");
}

export function proxy(request: NextRequest) {
  if (process.env.AUTH_REQUIRED !== "true") return NextResponse.next();
  const pathname = request.nextUrl.pathname;
  if (isPublicPath(pathname)) return NextResponse.next();

  const sessionCookie = getSessionCookie(request);
  if (!sessionCookie) {
    const target = new URL("/sign-in", request.url);
    target.searchParams.set("returnTo", `${pathname}${request.nextUrl.search}`);
    return NextResponse.redirect(target);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"]
};
