import { requireTeacherActor } from "@/features/teacher/server";
import { workflowStore } from "@/server/firestore/workflow";
import { handle, ok, readJson } from "@/server/http";

/** 先生の回答。対応待ちで未解決のときだけ保存され、同時に送った2件目は 409。 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ courseId: string; questionId: string }> },
) {
  return handle(request, async () => {
    const { courseId, questionId } = await params;
    const actor = await requireTeacherActor(request, courseId);
    const body = await readJson(request);
    return ok(await workflowStore.replyToQuestion(actor, courseId, questionId, { text: body.text }));
  });
}
