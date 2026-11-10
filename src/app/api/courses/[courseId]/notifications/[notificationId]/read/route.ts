import { requireStudentActor } from "@/features/student/server";
import { workflowStore } from "@/server/firestore/workflow";
import { handle, ok } from "@/server/http";

export async function POST(request: Request, { params }: { params: Promise<{ courseId: string; notificationId: string }> }) {
  return handle(request, async () => {
    const { courseId, notificationId } = await params;
    const actor = await requireStudentActor(request, courseId);
    return ok(await workflowStore.markNotificationRead(actor, courseId, notificationId));
  });
}
