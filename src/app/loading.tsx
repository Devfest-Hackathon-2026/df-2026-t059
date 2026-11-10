import { LoadingStatus } from "@/components/loading-status";

export default function Loading() {
  return <main className="page-loading" aria-busy="true"><LoadingStatus>ページを読み込んでいます…</LoadingStatus></main>;
}
