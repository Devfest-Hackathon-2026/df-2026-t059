import { requireTeacherActor } from "@/features/teacher/server";
import { workflowStore } from "@/server/firestore/workflow";
import { handle, ok, readJson } from "@/server/http";

/**
 * 編集を先生の編集版として保存し、選択中にする。
 * 開いた後にほかの先生が選択中の版を変えていたら 409（expectedSelectedVersionId で検知）。
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ courseId: string; questionId: string }> },
) {
  return handle(request, async () => {
    const { courseId, questionId } = await params;
    const actor = await requireTeacherActor(request, courseId);
    const body = await readJson(request);
    return ok(await workflowStore.saveDraftEdit(actor, courseId, questionId, {
      baseVersionId: body.baseVersionId,
      expectedSelectedVersionId: body.expectedSelectedVersionId,
      question: body.question,
      answer: body.answer,
      categoryId: body.categoryId,
    }));
  });
}
