import { getSessionCookie } from "better-auth/cookies";
import { NextRequest, NextResponse } from "next/server";

const PUBLIC_PREFIXES = ["/sign-in", "/api/auth", "/api/health"];

export function proxy(request: NextRequest) {
  if (process.env.AUTH_REQUIRED !== "true") return NextResponse.next();
  const pathname = request.nextUrl.pathname;
  if (PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return NextResponse.next();

  const sessionCookie = getSessionCookie(request);
  if (!sessionCookie) {
    const target = new URL("/sign-in", request.url);
    target.searchParams.set("returnTo", pathname);
    return NextResponse.redirect(target);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"]
};
