// 画面と URL クエリの対応の単体テスト（Firebase 不要）。npm run check:rules
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseStudentLocation, type StudentLocation, studentLocationSearch, studentSearchFromPage } from "../src/features/student/student-location.ts";
import { parseTeacherLocation, type TeacherLocation, teacherLocationSearch, teacherSearchFromPage } from "../src/features/teacher/teacher-location.ts";

const query = (search: string) => new URLSearchParams(search);

describe("生徒画面の URL", () => {
  const cases: [StudentLocation, string][] = [
    [{ tab: "chat" }, ""],
    [{ tab: "history" }, "?view=history"],
    [{ tab: "shared" }, "?view=shared"],
    [{ tab: "thread", id: "q 1/あ" }, "?question=q+1%2F%E3%81%82"],
    [{ tab: "chat", sourceQuestionId: "q1" }, "?relatedTo=q1"],
  ];
  for (const [location, search] of cases) {
    test(`${search || "クエリなし"} と相互に変換できる`, () => {
      assert.equal(studentLocationSearch(location), search);
      assert.deepEqual(parseStudentLocation(query(search)), location);
    });
  }

  test("知らない値・空の ID は新しい質問になる", () => {
    assert.deepEqual(parseStudentLocation(query("?view=admin")), { tab: "chat" });
    assert.deepEqual(parseStudentLocation(query("?question=")), { tab: "chat" });
  });

  test("質問の指定は一覧の指定より優先する", () => {
    assert.deepEqual(parseStudentLocation(query("?view=history&question=q1")), { tab: "thread", id: "q1" });
  });

  test("ログイン後の戻り先に知らないパラメータを引き継がない", () => {
    assert.equal(studentSearchFromPage({ question: "q1", next: "https://outside.example" }), "?question=q1");
    assert.equal(studentSearchFromPage({ question: ["q1", "q2"] }), "");
  });
});

describe("教員画面の URL", () => {
  const cases: [TeacherLocation, string][] = [
    [{ view: "board" }, ""],
    [{ view: "board", question: "q1" }, "?question=q1"],
    [{ view: "review" }, "?view=review"],
    [{ view: "review", question: "q1" }, "?view=review&question=q1"],
    [{ view: "review", dismissed: "q1" }, "?view=review&dismissed=q1"],
    [{ view: "published" }, "?view=published"],
    [{ view: "settings" }, "?view=settings"],
  ];
  for (const [location, search] of cases) {
    test(`${search || "クエリなし"} と相互に変換できる`, () => {
      assert.equal(teacherLocationSearch(location), search);
      assert.deepEqual(parseTeacherLocation(query(search)), location);
    });
  }

  test("知らないタブは質問対応になる", () => {
    assert.deepEqual(parseTeacherLocation(query("?view=admin")), { view: "board" });
  });

  test("質問を開けないタブでは ID を無視する", () => {
    assert.deepEqual(parseTeacherLocation(query("?view=settings&question=q1")), { view: "settings" });
    assert.deepEqual(parseTeacherLocation(query("?dismissed=q1")), { view: "board" });
  });

  test("ログイン後の戻り先に知らないパラメータを引き継がない", () => {
    assert.equal(teacherSearchFromPage({ view: "review", question: "q1", code: "SECRET" }), "?view=review&question=q1");
  });
});
