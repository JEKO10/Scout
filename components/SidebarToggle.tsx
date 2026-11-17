"use client";

/**
 * Opens and closes the sidebar on small screens. The open state lives on
 * <body data-nav-open> so the server-rendered sidebar needs no client state.
 */
export function SidebarToggle() {
  return (
    <button
      type="button"
      className="sidebar-toggle"
      aria-label="Open menu"
      aria-controls="app-sidebar"
      onClick={() => document.body.toggleAttribute("data-nav-open")}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 6h16M4 12h16M4 18h16" />
      </svg>
    </button>
  );
}

/** Click outside the open drawer closes it */
export function SidebarBackdrop() {
  return <div className="sidebar-backdrop" aria-hidden="true" onClick={() => document.body.removeAttribute("data-nav-open")} />;
}
