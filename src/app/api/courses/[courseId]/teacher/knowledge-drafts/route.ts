import { requireTeacherActor } from "@/features/teacher/server";
import { invalidInput } from "@/server/errors";
import { workflowStore } from "@/server/firestore/workflow";
import { handle, ok } from "@/server/http";

/**
 * 共有候補の一覧。既定は未公開・未見送り（確認待ち・生成中・生成失敗を含む）。
 * `?publication=dismissed` で見送った候補を返す。
 */
export async function GET(request: Request, { params }: { params: Promise<{ courseId: string }> }) {
  return handle(request, async () => {
    const { courseId } = await params;
    // ログインの確認を先に行う。未ログインには入力の誤りより先に 401 を返す。
    const actor = await requireTeacherActor(request, courseId);
    const publication = new URL(request.url).searchParams.get("publication");
    if (publication !== null && publication !== "dismissed") {
      throw invalidInput("publication は dismissed だけ指定できます。");
    }
    return ok(await workflowStore.listDrafts(actor, courseId, publication ? { publication: ["dismissed"] } : {}));
  });
}
