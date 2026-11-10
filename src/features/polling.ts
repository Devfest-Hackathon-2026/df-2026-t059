/** 表示中は10秒、非表示中は30秒。前の取得が終わってから次を待つ。 */
export function startPolling(run: () => Promise<boolean> | Promise<void>, immediately = true) {
  let timer: ReturnType<typeof setTimeout>;
  let running = false;
  let stopped = false;
  const schedule = () => {
    if (!stopped) timer = setTimeout(tick, document.hidden ? 30_000 : 10_000);
  };
  async function tick() {
    if (running || stopped) return;
    running = true;
    try {
      if (await run() === false) stopped = true;
    } finally {
      running = false;
      schedule();
    }
  }
  const visibilityChanged = () => {
    clearTimeout(timer);
    if (!document.hidden) void tick();
    else if (!running) schedule();
  };
  document.addEventListener("visibilitychange", visibilityChanged);
  if (immediately) timer = setTimeout(tick);
  else schedule();
  return () => {
    stopped = true;
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", visibilityChanged);
  };
}
