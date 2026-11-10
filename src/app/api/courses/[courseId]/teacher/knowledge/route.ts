import { requireTeacherActor } from "@/features/teacher/server";
import { workflowStore } from "@/server/firestore/workflow";
import { handle, ok } from "@/server/http";

/** 教員画面の「共有済みQ&A」。担当教員以外は存在しない場合と同じ 404（入口とストアの両方で確認する）。 */
export async function GET(request: Request, { params }: { params: Promise<{ courseId: string }> }) {
  return handle(request, async () => {
    const { courseId } = await params;
    const actor = await requireTeacherActor(request, courseId);
    return ok(await workflowStore.listTeacherKnowledge(actor, courseId));
  });
}
