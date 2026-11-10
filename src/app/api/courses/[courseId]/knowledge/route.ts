import { requireStudentActor } from "@/features/student/server";
import { workflowStore } from "@/server/firestore/workflow";
import { handle, ok } from "@/server/http";

export async function GET(request: Request, { params }: { params: Promise<{ courseId: string }> }) {
  return handle(request, async () => {
    const { courseId } = await params;
    const actor = await requireStudentActor(request, courseId);
    return ok(await workflowStore.listPublishedKnowledge(actor, courseId));
  });
}
