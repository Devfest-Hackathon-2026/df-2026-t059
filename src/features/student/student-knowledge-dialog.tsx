import { useCallback, useEffect, useRef, useState } from "react";
import type { PublishedKnowledgeDTO } from "../../domain/course-workflow.ts";
import { Dialog } from "@/components/dialog";
import { MessageBody } from "@/components/message-body";
import { LoadingStatus } from "@/components/loading-status";
import { MathTitle } from "@/components/math-title";
import { StudentApiError } from "./api";

export function StudentKnowledgeDialog({ knowledgeId, readKnowledge, onClose }: {
  knowledgeId: string;
  readKnowledge: (id: string) => Promise<PublishedKnowledgeDTO>;
  onClose: () => void;
}) {
  const [item, setItem] = useState<PublishedKnowledgeDTO>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const latest = useRef(0);
  const load = useCallback(async () => {
    const request = ++latest.current;
    setLoading(true);
    setError(undefined);
    setUnavailable(false);
    setItem(undefined);
    try {
      const knowledge = await readKnowledge(knowledgeId);
      if (request === latest.current) setItem(knowledge);
    } catch (cause) {
      if (request === latest.current) {
        const gone = cause instanceof StudentApiError && cause.code === "NOT_FOUND";
        setUnavailable(gone);
        setError(gone ? "このQ&Aは現在公開されていません。先生が取り下げた可能性があります。"
          : cause instanceof StudentApiError ? cause.message : "Q&Aを取得できませんでした。");
      }
    } finally {
      if (request === latest.current) setLoading(false);
    }
  }, [knowledgeId, readKnowledge]);

  useEffect(() => {
    const timer = setTimeout(() => void load());
    return () => { latest.current++; clearTimeout(timer); };
  }, [load]);

  return (
    <Dialog title={<MathTitle text={item?.question ?? "参考Q&A"} />} onClose={onClose}>
      {loading && <LoadingStatus>Q&Aを読み込んでいます。</LoadingStatus>}
      {error && <div className="student-error" role="alert"><p>{error}</p>
        {!unavailable && <button type="button" className="secondary-button" onClick={() => void load()}>再読み込み</button>}
      </div>}
      {!loading && item && <MessageBody text={item.answer} className="knowledge-answer" />}
    </Dialog>
  );
}
