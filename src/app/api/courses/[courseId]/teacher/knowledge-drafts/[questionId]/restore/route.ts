import { requireTeacherActor } from "@/features/teacher/server";
import { workflowStore } from "@/server/firestore/workflow";
import { handle, ok } from "@/server/http";

/** 見送った候補を確認待ちに戻す。生成中・公開中は 409、確認待ちへの再送はそのまま成功。 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ courseId: string; questionId: string }> },
) {
  return handle(request, async () => {
    const { courseId, questionId } = await params;
    const actor = await requireTeacherActor(request, courseId);
    return ok(await workflowStore.restoreDraft(actor, courseId, questionId));
  });
}
