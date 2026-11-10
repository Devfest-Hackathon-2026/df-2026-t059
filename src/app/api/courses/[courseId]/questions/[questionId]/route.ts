import { studentView } from "@/server/auth/access";
import { requireCourseActor } from "@/server/auth/actor";
import { workflowStore } from "@/server/firestore/workflow";
import { handle, ok } from "@/server/http";

/**
 * 相談の詳細。本人には生徒用、担当教員には本人表示つきの教員用を返す。
 * それ以外（未参加・他の生徒・別講義の教員）は存在しない場合と同じ 404。
 * `?view=student` は兼任者の生徒画面用で、教員の権限を外した主体で読む（参加済み本人の相談だけが生徒用DTOで返る）。
 * クエリで権限が増えることはない。
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ courseId: string; questionId: string }> },
) {
  return handle(request, async () => {
    const { courseId, questionId } = await params;
    const actor = await requireCourseActor(request, courseId);
    const viewer = new URL(request.url).searchParams.get("view") === "student" ? studentView(actor) : actor;
    return ok(await workflowStore.readThread(viewer, courseId, questionId));
  });
}
