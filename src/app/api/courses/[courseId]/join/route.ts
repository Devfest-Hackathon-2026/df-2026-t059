import { requirePrincipal } from "@/server/auth/actor";
import { workflowStore } from "@/server/firestore/workflow";
import { handle, ok, readJson } from "@/server/http";

/** 参加コードを引き換えて講義に参加する。参加済みなら何もしない。 */
export async function POST(request: Request, { params }: { params: Promise<{ courseId: string }> }) {
  return handle(request, async () => {
    const { courseId } = await params;
    const principal = await requirePrincipal(request);
    const body = await readJson(request);
    return ok(await workflowStore.redeemInvite(principal, courseId, { code: body.code }));
  });
}
