import { requirePrincipal } from "@/server/auth/actor";
import { workflowStore } from "@/server/firestore/workflow";
import { handle, ok, readJson } from "@/server/http";

export async function POST(request: Request) {
  return handle(request, async () => {
    const principal = await requirePrincipal(request);
    const id = await workflowStore.createCourse(principal, await readJson(request));
    return ok({ id }, 201);
  });
}
