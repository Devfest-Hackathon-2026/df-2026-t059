import "server-only";
import { ZodError } from "zod";
import type { ApiFailure, ApiSuccess } from "../domain/course-workflow.ts";
import { AppError, forbidden, invalidInput, isAppError } from "./errors.ts";

// Route Handler の共通処理。成功は { data }、失敗は { error: { code, message } }。
// エラー本文に内部例外・原文・秘密値を入れない。

export function ok<T>(data: T, status = 200): Response {
  return Response.json({ data } satisfies ApiSuccess<T>, { status, headers: { "Cache-Control": "no-store" } });
}

export function fail(error: AppError): Response {
  const headers = new Headers({ "Cache-Control": "no-store" });
  if (error.retryAfterSeconds !== undefined) headers.set("Retry-After", String(error.retryAfterSeconds));
  return Response.json(
    { error: { code: error.code, message: error.message } } satisfies ApiFailure,
    { status: error.status, headers },
  );
}

/**
 * 状態を変える要求で、別サイトからのフォーム送信などを拒否する（SameSite=Lax の Cookie と併用）。
 * Origin がない要求（同一オリジンの一部ブラウザ・サーバー間通信）は通す。
 */
export function assertSameOrigin(request: Request) {
  if (request.method === "GET" || request.method === "HEAD") return;
  const origin = request.headers.get("origin");
  if (!origin) return;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw forbidden();
  }
  if (!host || originHost !== host) throw forbidden();
}

/** JSON 本文を読む。壊れた JSON は 400。 */
export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json();
    if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {
    // fallthrough
  }
  throw invalidInput("JSON の本文を送ってください。");
}

/** Route Handler をこれで包む：同一オリジン確認と、例外から共通エラーへの変換。 */
export async function handle(request: Request, run: () => Promise<Response>): Promise<Response> {
  try {
    assertSameOrigin(request);
    return await run();
  } catch (error) {
    if (isAppError(error)) return fail(error);
    if (error instanceof ZodError) return fail(invalidInput());
    console.error("[api] internal error", error instanceof Error ? error.name : "unknown");
    return fail(new AppError("INTERNAL_ERROR", "サーバーでエラーが発生しました。"));
  }
}
