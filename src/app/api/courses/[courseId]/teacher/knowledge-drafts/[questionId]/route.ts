import { requireTeacherActor } from "@/features/teacher/server";
import { workflowStore } from "@/server/firestore/workflow";
import { handle, ok } from "@/server/http";

/** 候補の詳細（版の一覧と生成状態）。担当教員だけ。 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ courseId: string; questionId: string }> },
) {
  return handle(request, async () => {
    const { courseId, questionId } = await params;
    const actor = await requireTeacherActor(request, courseId);
    return ok(await workflowStore.readDraft(actor, courseId, questionId));
  });
}
