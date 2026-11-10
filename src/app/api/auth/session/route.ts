import { cookies } from "next/headers";
import { createSessionCookie, SESSION_COOKIE, sessionCookieOptions } from "@/server/auth/session";
import { invalidInput } from "@/server/errors";
import { handle, ok, readJson } from "@/server/http";

/** Firebase Authentication の ID トークンを httpOnly のセッション Cookie に交換する。 */
export async function POST(request: Request) {
  return handle(request, async () => {
    const body = await readJson(request);
    if (typeof body.idToken !== "string" || !body.idToken) throw invalidInput();
    const session = await createSessionCookie(body.idToken);
    (await cookies()).set(SESSION_COOKIE, session.value, sessionCookieOptions(session.maxAgeSeconds));
    return ok({ signedIn: true });
  });
}
