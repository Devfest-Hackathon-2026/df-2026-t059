import { createStudentQuestion, requireStudentActor } from "@/features/student/server";
import { workflowStore } from "@/server/firestore/workflow";
import { handle, ok, readJson } from "@/server/http";

export async function GET(request: Request, { params }: { params: Promise<{ courseId: string }> }) {
  return handle(request, async () => {
    const { courseId } = await params;
    const actor = await requireStudentActor(request, courseId);
    return ok(await workflowStore.listOwnThreads(actor, courseId));
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ courseId: string }> }) {
  return handle(request, async () => {
    const { courseId } = await params;
    const actor = await requireStudentActor(request, courseId);
    const { text, sourceQuestionId } = await readJson(request);
    return ok(await createStudentQuestion(actor, courseId, text, sourceQuestionId), 201);
  });
}
