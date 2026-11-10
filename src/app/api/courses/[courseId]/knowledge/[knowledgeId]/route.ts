import { requireStudentActor } from "@/features/student/server";
import { workflowStore } from "@/server/firestore/workflow";
import { handle, ok } from "@/server/http";

export async function GET(request: Request, { params }: { params: Promise<{ courseId: string; knowledgeId: string }> }) {
  return handle(request, async () => {
    const { courseId, knowledgeId } = await params;
    const actor = await requireStudentActor(request, courseId);
    return ok(await workflowStore.readPublishedKnowledge(actor, courseId, knowledgeId));
  });
}
