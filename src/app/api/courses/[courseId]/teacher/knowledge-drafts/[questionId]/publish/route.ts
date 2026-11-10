import { requireTeacherActor } from "@/features/teacher/server";
import { workflowStore } from "@/server/firestore/workflow";
import { handle, ok, readJson } from "@/server/http";

/**
 * 表示中の内容で共有する。内容が元の版と違えばストアが先生の編集版を作ってから公開する。
 * 同じ内容の再送は既存の結果、別の内容は 409。
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ courseId: string; questionId: string }> },
) {
  return handle(request, async () => {
    const { courseId, questionId } = await params;
    const actor = await requireTeacherActor(request, courseId);
    const body = await readJson(request);
    return ok(await workflowStore.publishDraft(actor, courseId, questionId, {
      versionId: body.versionId,
      question: body.question,
      answer: body.answer,
      categoryId: body.categoryId,
    }));
  });
}
