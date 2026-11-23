// The five navigation glyphs, drawn for VetraTD (solid, 24-unit grid). Spec
// §10: no stock icons in coloured circles; rows lead with words or the time.
// Decorative only: the navigation label carries the meaning.

function Glyph({ size, children }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function HomeIcon({ size = 22 }) {
  return (
    <Glyph size={size}>
      <path d="M12 3.4 3.6 10.3c-.4.3-.6.8-.6 1.3v7.9c0 .8.7 1.5 1.5 1.5h5v-5.2c0-.5.4-.8.8-.8h3.4c.5 0 .8.4.8.8V21h5c.8 0 1.5-.7 1.5-1.5v-7.9c0-.5-.2-1-.6-1.3z" />
    </Glyph>
  );
}

export function InboxIcon({ size = 22 }) {
  return (
    <Glyph size={size}>
      <path
        fillRule="evenodd"
        d="M5.2 4h13.6c.7 0 1.3.5 1.5 1.1L22 12.4v6.1c0 .8-.7 1.5-1.5 1.5h-17C2.7 20 2 19.3 2 18.5v-6.1l1.7-7.3C3.9 4.5 4.5 4 5.2 4zm.6 2-1.4 5.5H8c.6 0 1 .3 1.2.8.4 1 1.5 1.7 2.8 1.7s2.4-.7 2.8-1.7c.2-.5.6-.8 1.2-.8h3.6L18.2 6z"
      />
    </Glyph>
  );
}

export function CalendarIcon({ size = 22 }) {
  return (
    <Glyph size={size}>
      <path
        fillRule="evenodd"
        d="M7 2.5c.6 0 1 .4 1 1v1h8v-1c0-.6.4-1 1-1s1 .4 1 1v1h.8c1.2 0 2.2 1 2.2 2.2v11.6c0 1.2-1 2.2-2.2 2.2H5.2C4 20.5 3 19.5 3 18.3V6.7c0-1.2 1-2.2 2.2-2.2H6v-1c0-.6.4-1 1-1zM5 9.5v8.6c0 .2.2.4.4.4h13.2c.2 0 .4-.2.4-.4V9.5zm2.5 2h3v3h-3z"
      />
    </Glyph>
  );
}

export function AgentIcon({ size = 22 }) {
  return (
    <Glyph size={size}>
      <rect x="2.4" y="10" width="2.6" height="4" rx="1.3" />
      <rect x="6.6" y="6.5" width="2.6" height="11" rx="1.3" />
      <rect x="10.7" y="3" width="2.6" height="18" rx="1.3" />
      <rect x="14.8" y="7.5" width="2.6" height="9" rx="1.3" />
      <rect x="19" y="9.8" width="2.6" height="4.4" rx="1.3" />
    </Glyph>
  );
}

export function SettingsIcon({ size = 22 }) {
  return (
    <Glyph size={size}>
      <rect x="3" y="7" width="18" height="2" rx="1" />
      <circle cx="8.5" cy="8" r="3" />
      <rect x="3" y="15" width="18" height="2" rx="1" />
      <circle cx="15.5" cy="16" r="3" />
    </Glyph>
  );
}
