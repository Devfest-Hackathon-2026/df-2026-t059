import { addStudentMessage, requireStudentActor } from "@/features/student/server";
import { handle, ok, readJson } from "@/server/http";

export async function POST(request: Request, { params }: { params: Promise<{ courseId: string; questionId: string }> }) {
  return handle(request, async () => {
    const { courseId, questionId } = await params;
    const actor = await requireStudentActor(request, courseId);
    const { text } = await readJson(request);
    return ok(await addStudentMessage(actor, courseId, questionId, text));
  });
}
