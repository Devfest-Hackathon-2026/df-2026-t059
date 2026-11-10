import { Icon } from "@/components/icon";
import { MessageBody } from "@/components/message-body";
import type { MessageDTO } from "../workflow-types.ts";

// 共通の Conversation が文字列IDと「AIの回答」に対応するまでの教員画面用。C の対応後に置き換える。
const roleLabels: Record<MessageDTO["role"], string> = { student: "生徒", assistant: "AIの回答", teacher: "先生" };

export function ThreadMessages({ messages }: { messages: MessageDTO[] }) {
  const ordered = [...messages].sort((a, b) => a.sequence - b.sequence);
  return (
    <ol className="conversation" aria-label="会話履歴">
      {ordered.map((message) => (
        <li className={`message message--${message.role}`} key={message.id}>
          <span className="message-author">
            {message.role === "assistant" && <Icon name="sparkle" size={14} />}
            {roleLabels[message.role]}
          </span>
          <MessageBody text={message.text} />
        </li>
      ))}
    </ol>
  );
}
