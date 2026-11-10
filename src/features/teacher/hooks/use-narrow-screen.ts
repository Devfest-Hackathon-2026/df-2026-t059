import { useSyncExternalStore } from "react";

// globals.css と teacher.module.css の、画面を1列にする幅に揃える。
const NARROW_QUERY = "(max-width: 760px)";

function subscribe(onChange: () => void) {
  const media = window.matchMedia(NARROW_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

/** スマホなどの狭い画面か。画面の回転にも追従する。 */
export function useNarrowScreen() {
  return useSyncExternalStore(subscribe, () => window.matchMedia(NARROW_QUERY).matches, () => false);
}
