import type { ReactNode } from "react";

export function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

export function LoadingStatus({ children, className }: { children: ReactNode; className?: string }) {
  return <p role="status" className={className ? `loading-status ${className}` : "loading-status"}><Spinner />{children}</p>;
}
