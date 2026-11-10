import { requireTeacherActor } from "@/features/teacher/server";
import { workflowStore } from "@/server/firestore/workflow";
import { handle, ok, readJson } from "@/server/http";

/** カテゴリの追加。返り値は並び順にそろえた講義のカテゴリ全体。同名は 409。 */
export async function POST(request: Request, { params }: { params: Promise<{ courseId: string }> }) {
  return handle(request, async () => {
    const { courseId } = await params;
    const actor = await requireTeacherActor(request, courseId);
    const body = await readJson(request);
    return ok(await workflowStore.addCategory(actor, courseId, { name: body.name }), 201);
  });
}
