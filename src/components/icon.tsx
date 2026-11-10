const iconPaths = {
  book: "M12 7c-3-3-6-3-9-2v14c3-1 6-1 9 2 3-3 6-3 9-2V5c-3-1-6-1-9 2Zm0 0v14",
  bell: "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9Zm-8 12a2 2 0 0 0 4 0",
  chat: "M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l1.8-4.1A8.5 8.5 0 1 1 21 11.5Z",
  history: "M3 12a9 9 0 1 1 2.6 6.4M3 12V5m0 7h7m2-4v5l3 2",
  board: "M3 5h18v14H3zM9 5v14m6-14v14",
  check: "m5 12 4 4L19 6",
  arrow: "M4 12h15m-6-6 6 6-6 6",
  send: "M12 20V4m-6 6 6-6 6 6",
  menu: "M4 6h16M4 12h16M4 18h16",
  settings: "M10 3h4l.6 2.7 1.7 1 2.6-.8 2 3.4-2 1.9v2.1l2 1.9-2 3.4-2.6-.8-1.7 1L14 21h-4l-.6-2.7-1.7-1-2.6.8-2-3.4 2-1.9v-2.1l-2-1.9 2-3.4 2.6.8 1.7-1L10 3Zm5 9a3 3 0 1 0-6 0 3 3 0 0 0 6 0Z",
  plus: "M12 5v14M5 12h14",
  close: "m6 6 12 12M18 6 6 18",
  sparkle: "M12 2c0 6-4 10-10 10 6 0 10 4 10 10 0-6 4-10 10-10-6 0-10-4-10-10Z",
};

export function Icon({ name, size = 18 }: { name: keyof typeof iconPaths; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={iconPaths[name]} />
    </svg>
  );
}
