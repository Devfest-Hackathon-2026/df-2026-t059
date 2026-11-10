import { Icon } from "./icon";
import { MessageBody } from "./message-body";
import { MathTitle } from "./math-title";

export type ConversationMessage = {
  id: number | string;
  role: "student" | "assistant" | "teacher";
  text: string;
  referencedKnowledgeIds?: string[];
  sample?: boolean;
  lowConfidence?: boolean;
};

export function Conversation({ messages, sample = false, onOpenKnowledge, knowledgeTitles = {}, label = "会話履歴" }: {
  messages: ConversationMessage[];
  sample?: boolean;
  onOpenKnowledge?: (id: string) => void;
  knowledgeTitles?: Record<string, string>;
  label?: string;
}) {
  return (
    <ol className="conversation" aria-label={label}>
      {messages.map((message) => (
        <li className={`message message--${message.role}`} key={message.id}>
          <span className="message-author">
            {message.role === "assistant" && <Icon name="sparkle" size={14} />}
            {{ student: "生徒", assistant: (message.sample ?? sample) ? "AIの回答例" : "AIの回答", teacher: "先生" }[message.role]}
          </span>
          <MessageBody text={message.text} />
          {message.role === "assistant" && onOpenKnowledge && !!message.referencedKnowledgeIds?.length && (
            <section className="message-references" aria-label="参考Q&A">
              <span className="reference-heading">参考Q&A</span>
              {[...new Set(message.referencedKnowledgeIds)].map((id, index) => (
                <button type="button" key={id} className="reference-button" aria-haspopup="dialog" onClick={() => onOpenKnowledge(id)}>
                  <Icon name="book" size={15} /> <span><MathTitle text={knowledgeTitles[id] ?? `参考Q&A ${index + 1}`} /></span>
                </button>
              ))}
            </section>
          )}
        </li>
      ))}
    </ol>
  );
}
