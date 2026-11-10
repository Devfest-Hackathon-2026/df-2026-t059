import { requireTeacherActor } from "@/features/teacher/server";
import { workflowStore } from "@/server/firestore/workflow";
import { handle, ok } from "@/server/http";

type Context = { params: Promise<{ courseId: string }> };

/** 有効な招待があるか。コードは保存していないため返さない。 */
export async function GET(request: Request, { params }: Context) {
  return handle(request, async () => {
    const { courseId } = await params;
    const actor = await requireTeacherActor(request, courseId);
    return ok(await workflowStore.getInviteStatus(actor, courseId));
  });
}

/** 招待の発行・再発行。古い招待は失効する。コードはこの応答でだけ返る。 */
export async function POST(request: Request, { params }: Context) {
  return handle(request, async () => {
    const { courseId } = await params;
    const actor = await requireTeacherActor(request, courseId);
    return ok(await workflowStore.issueInvite(actor, courseId), 201);
  });
}

/** 招待の無効化。参加済みの生徒はそのまま使える。 */
export async function DELETE(request: Request, { params }: Context) {
  return handle(request, async () => {
    const { courseId } = await params;
    const actor = await requireTeacherActor(request, courseId);
    return ok(await workflowStore.revokeInvites(actor, courseId));
  });
}
