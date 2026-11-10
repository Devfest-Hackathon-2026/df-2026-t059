import { type DraftRequestMode, requestTeacherDraft, requireTeacherActor } from "@/features/teacher/server";
import { invalidInput } from "@/server/errors";
import { handle, ok, readJson } from "@/server/http";

function parseMode(value: unknown): DraftRequestMode {
  if (value === undefined || value === "regenerate") return "regenerate";
  if (value === "retry") return "retry";
  throw invalidInput("mode は regenerate か retry を指定してください。");
}

/**
 * AIで共有候補を作る（候補がなければ新規、あれば別案）。mode=retry は直前の生成が失敗したときの再試行。
 * 要約が終わるまで待ち、生成後の候補を返す。要約の失敗は lastGeneration で伝える。生成中・AI回答中は 409。
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ courseId: string; questionId: string }> },
) {
  return handle(request, async () => {
    const { courseId, questionId } = await params;
    const actor = await requireTeacherActor(request, courseId);
    const body = await readJson(request);
    return ok(await requestTeacherDraft(actor, courseId, questionId, parseMode(body.mode)));
  });
}
