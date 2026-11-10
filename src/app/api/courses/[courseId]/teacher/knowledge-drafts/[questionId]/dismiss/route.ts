import { requireTeacherActor } from "@/features/teacher/server";
import { workflowStore } from "@/server/firestore/workflow";
import { handle, ok } from "@/server/http";

/** 候補の共有を見送る。公開済みは 409、見送り済みへの再送はそのまま成功。 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ courseId: string; questionId: string }> },
) {
  return handle(request, async () => {
    const { courseId, questionId } = await params;
    const actor = await requireTeacherActor(request, courseId);
    return ok(await workflowStore.dismissDraft(actor, courseId, questionId));
  });
}
