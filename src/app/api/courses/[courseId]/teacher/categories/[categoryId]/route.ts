import { requireTeacherActor } from "@/features/teacher/server";
import { workflowStore } from "@/server/firestore/workflow";
import { handle, ok, readJson } from "@/server/http";

/** カテゴリ名・並び順の変更。削除は未合意のため用意しない。 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ courseId: string; categoryId: string }> },
) {
  return handle(request, async () => {
    const { courseId, categoryId } = await params;
    const actor = await requireTeacherActor(request, courseId);
    const body = await readJson(request);
    return ok(await workflowStore.updateCategory(actor, courseId, categoryId, { name: body.name, order: body.order }));
  });
}
