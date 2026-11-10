import "server-only";

// 旧来の質問保存（createPendingQuestion / readQuestion）は、11/7 の共通ストアに置き換えた。
// 新しいコードは src/server/firestore/workflow.ts の workflowStore を直接使う。

export { workflowStore } from "../../server/firestore/workflow.ts";
