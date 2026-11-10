import { requireTeacherActor } from "@/features/teacher/server";
import { workflowStore } from "@/server/firestore/workflow";
import { handle, ok, readJson } from "@/server/http";

/** 別の案を選択中にする（内容は変えない）。並行編集の検知は edit と同じ。 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ courseId: string; questionId: string }> },
) {
  return handle(request, async () => {
    const { courseId, questionId } = await params;
    const actor = await requireTeacherActor(request, courseId);
    const body = await readJson(request);
    return ok(await workflowStore.selectDraftVersion(actor, courseId, questionId, {
      versionId: body.versionId,
      expectedSelectedVersionId: body.expectedSelectedVersionId,
    }));
  });
}
