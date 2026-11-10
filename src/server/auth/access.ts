// 認可の判定を1か所にまとめる。HTTP の入口（Route Handler・ページ）とストアの両方がここを呼ぶ。
// Admin SDK は Firestore のセキュリティルールを通らないため、ここでの判定がアクセス制御そのものになる。
// このファイルは Firebase に依存しない（単体テストできるようにする）。

/** 検証済みセッションから取り出した本人。ブラウザが送る uid・役割・メールは使わない。 */
export type Principal = {
  uid: string;
  /** email_verified のときだけ入る。小文字に正規化する。 */
  email: string | null;
  /** Firebase Authentication のアカウントの表示名（取得できなければ null）。 */
  name: string | null;
};

/**
 * ある講義での利用者。役割は排他的な1値ではなく、独立したフラグで持つ。
 * 11/7 の決定で役割は「参加済み生徒」と「担当教員」だけ（講義管理者・全体管理者は当面なし）。
 */
export type CourseActor = {
  principal: Principal;
  courseId: string;
  /** 招待を引き換えて講義に参加済み。 */
  enrolled: boolean;
  /** courses.teacherEmails に検証済みメールが含まれる。 */
  teacher: boolean;
};

export type ThreadRef = { courseId: string; studentId: string };

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isTeacherEmail(email: string | null, teacherEmails: readonly string[]): boolean {
  if (!email) return false;
  const target = normalizeEmail(email);
  return teacherEmails.some((candidate) => normalizeEmail(candidate) === target);
}

/** 新規講義の担当者として登録できる、確認済みのメールがあるか。 */
export function canCreateCourse(principal: Principal): principal is Principal & { email: string } {
  return Boolean(principal.email);
}

function sameCourse(actor: CourseActor, courseId: string): boolean {
  return actor.courseId === courseId;
}

/** 自分の相談の持ち主（参加済みの生徒）。 */
export function isThreadOwner(actor: CourseActor, thread: ThreadRef): boolean {
  return sameCourse(actor, thread.courseId) && actor.enrolled && actor.principal.uid === thread.studentId;
}

/** 原文（会話）を読める：本人か、その講義の担当教員。 */
export function canReadThread(actor: CourseActor, thread: ThreadRef): boolean {
  return isThreadOwner(actor, thread) || (sameCourse(actor, thread.courseId) && actor.teacher);
}

/** 本人表示（表示名・代替メール）を読める：その講義の担当教員だけ。 */
export function canSeeStudentIdentity(actor: CourseActor, thread: ThreadRef): boolean {
  return sameCourse(actor, thread.courseId) && actor.teacher;
}

/** 生徒としての操作（投稿・自分の一覧）。 */
export function canActAsStudent(actor: CourseActor, courseId: string): boolean {
  return sameCourse(actor, courseId) && actor.enrolled;
}

/** 教員としての操作（返信・候補・公開・見送り・カテゴリ・招待）。 */
export function canActAsTeacher(actor: CourseActor, courseId: string): boolean {
  return sameCourse(actor, courseId) && actor.teacher;
}

/** 公開Q&A・講義情報を読める：参加済み生徒か担当教員。 */
export function canReadCourse(actor: CourseActor, courseId: string): boolean {
  return sameCourse(actor, courseId) && (actor.enrolled || actor.teacher);
}

/**
 * 生徒としてだけ振る舞う主体（生徒用 API と、兼任者が生徒画面で使う詳細取得）。
 * 検証済みの主体をコピーして teacher だけを外す。uid・courseId・enrolled は変えず、元の主体も変更しない。
 * 生徒としての権限（参加済みか・本人か）は、この主体に対する各判定で別に確認する。
 */
export function studentView(actor: CourseActor): CourseActor {
  return { ...actor, principal: { ...actor.principal }, teacher: false };
}

