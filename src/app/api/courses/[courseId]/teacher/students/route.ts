import { requireTeacherActor } from "@/features/teacher/server";
import { workflowStore } from "@/server/firestore/workflow";
import { handle, ok } from "@/server/http";

/** 講義に参加している生徒の人数。担当教員でなければ入口とストアで拒否する。 */
export async function GET(request: Request, { params }: { params: Promise<{ courseId: string }> }) {
  return handle(request, async () => {
    const { courseId } = await params;
    const actor = await requireTeacherActor(request, courseId);
    return ok({ count: await workflowStore.countStudents(actor, courseId) });
  });
}
