import { requireTeacherActor } from "@/features/teacher/server";
import { invalidInput } from "@/server/errors";
import { workflowStore } from "@/server/firestore/workflow";
import { handle, ok } from "@/server/http";

const boardStatuses = ["escalated", "teacher_answered", "ai_answered"] as const;
type BoardStatus = (typeof boardStatuses)[number];

function isBoardStatus(value: string | null): value is BoardStatus {
  return boardStatuses.some((status) => status === value);
}

/** 質問対応の一覧（対応待ち・回答済み・AIが回答した会話）。担当教員でなければストアが 404 を返す。 */
export async function GET(request: Request, { params }: { params: Promise<{ courseId: string }> }) {
  return handle(request, async () => {
    const { courseId } = await params;
    // ログインの確認を先に行う。未ログインには入力の誤りより先に 401 を返す。
    const actor = await requireTeacherActor(request, courseId);
    const status = new URL(request.url).searchParams.get("status");
    if (!isBoardStatus(status)) throw invalidInput("status は escalated・teacher_answered・ai_answered のいずれかを指定してください。");
    return ok(await workflowStore.listTeacherThreads(actor, courseId, status));
  });
}
