import { requireTeacherActor } from "@/features/teacher/server";
import { workflowStore } from "@/server/firestore/workflow";
import { handle, ok } from "@/server/http";

/** 公開Q&Aを取り下げる。元候補がある場合は確認待ちに戻し、元候補がない場合は削除だけ行う。 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ courseId: string; knowledgeId: string }> },
) {
  return handle(request, async () => {
    const { courseId, knowledgeId } = await params;
    const actor = await requireTeacherActor(request, courseId);
    return ok(await workflowStore.unpublishKnowledge(actor, courseId, knowledgeId));
  });
}
