import { cookies } from "next/headers";
import { SESSION_COOKIE, sessionCookieOptions } from "@/server/auth/session";
import { handle, ok } from "@/server/http";

/** この端末のセッション Cookie を消す（他の端末のログインは残す）。 */
export async function POST(request: Request) {
  return handle(request, async () => {
    (await cookies()).set(SESSION_COOKIE, "", sessionCookieOptions(0));
    return ok({ signedIn: false });
  });
}
