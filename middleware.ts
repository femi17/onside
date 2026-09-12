import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function middleware(request: NextRequest) {
  const res = await updateSession(request);
  // Referral capture: /?ref=CODE drops a 30-day cookie the app reads once after sign-up
  // (attribute_referral). First ref wins — never overwrite an existing one.
  const ref = request.nextUrl.searchParams.get("ref");
  if (ref && !request.cookies.get("onside_ref")) {
    res.cookies.set("onside_ref", ref.slice(0, 12), { maxAge: 60 * 60 * 24 * 30, path: "/", sameSite: "lax" });
  }
  return res;
}

export const config = {
  matcher: [
    // run on everything except static assets
    "/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
