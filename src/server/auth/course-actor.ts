import "server-only";
import { notFound } from "../errors.ts";
import { loadCourseMembership, loadCourseMemberships } from "../firestore/workflow.ts";
import { type CourseActor, isTeacherEmail, type Principal } from "./access.ts";

/**
 * 検証済みの本人から、講義での主体を作る。講義が存在しなければ 404。
 * 役割は毎回 Firestore から判定する（参加は enrollments、教員は courses.teacherEmails と検証済みメール）。
 */
export async function buildCourseActor(principal: Principal, courseId: string): Promise<CourseActor> {
  const membership = await loadCourseMembership(courseId, principal.uid);
  if (!membership) throw notFound();
  return {
    principal,
    courseId,
    enrolled: membership.enrolled,
    teacher: isTeacherEmail(principal.email, membership.teacherEmails),
  };
}

/** 本人が利用できる講義だけをホームの表示用に返す。 */
export async function listMyCourses(principal: Principal) {
  const memberships = await loadCourseMemberships(principal.uid);
  return memberships
    .map(({ id, name, enrolled, teacherEmails }) => ({
      id, name, enrolled, teacher: isTeacherEmail(principal.email, teacherEmails),
    }))
    .filter(({ enrolled, teacher }) => enrolled || teacher)
    .sort((a, b) => a.name.localeCompare(b.name, "ja"));
}
