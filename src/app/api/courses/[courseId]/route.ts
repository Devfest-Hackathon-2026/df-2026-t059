import { requireCourseActor } from "@/server/auth/actor";
import { workflowStore } from "@/server/firestore/workflow";
import { handle, ok } from "@/server/http";

/** 講義の公開情報と、ログイン中の利用者の役割（参加済みか・担当教員か）。 */
export async function GET(request: Request, { params }: { params: Promise<{ courseId: string }> }) {
  return handle(request, async () => {
    const { courseId } = await params;
    const actor = await requireCourseActor(request, courseId);
    return ok({
      course: await workflowStore.getCourseView(actor, courseId),
      viewer: workflowStore.getCourseViewer(actor),
    });
  });
}
