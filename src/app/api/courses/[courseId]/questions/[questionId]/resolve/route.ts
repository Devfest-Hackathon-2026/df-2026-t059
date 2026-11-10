import { requireStudentActor, resolveStudentQuestion } from "@/features/student/server";
import { handle, ok } from "@/server/http";

export async function POST(request: Request, { params }: { params: Promise<{ courseId: string; questionId: string }> }) {
  return handle(request, async () => {
    const { courseId, questionId } = await params;
    const actor = await requireStudentActor(request, courseId);
    return ok(await resolveStudentQuestion(actor, courseId, questionId));
  });
}
