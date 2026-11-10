import type { TeacherWorkflowClient } from "../api/client.ts";
import type { CourseCategory, InviteDTO } from "../workflow-types.ts";
import { CategorySettings } from "./category-settings";
import { InviteSettings } from "./invite-settings";
import styles from "./teacher.module.css";

/** 担当講義の設定（カテゴリと生徒の招待）。 */
export function CourseSettings({ client, courseId, categories, onCategoriesChange, issuedInvite, onIssued }: {
  client: TeacherWorkflowClient;
  courseId: string;
  categories: CourseCategory[];
  onCategoriesChange: (categories: CourseCategory[]) => void;
  issuedInvite: InviteDTO | undefined;
  onIssued: (invite: InviteDTO) => void;
}) {
  return (
    <>
      <div className="view-heading">
        <h1>講義の設定</h1>
        <p>カテゴリの追加・変更と、生徒の招待を行います。</p>
      </div>
      <div className={styles.settingsStack}>
        <CategorySettings client={client} categories={categories} onChange={onCategoriesChange} />
        <InviteSettings client={client} courseId={courseId} issuedInvite={issuedInvite} onIssued={onIssued} />
      </div>
    </>
  );
}
