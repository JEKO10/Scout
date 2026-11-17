"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

// 24×24 stroke icons (drawn in the style of the design's line icons)
const icons: Record<string, ReactNode> = {
  home: <path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />,
  target: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1" />
    </>
  ),
  chat: <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />,
  eye: (
    <>
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  compass: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m15.5 8.5-2 5-5 2 2-5z" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14a6.5 6.5 0 0 1 3.5 6" />
    </>
  ),
  trend: <path d="m3 17 6-6 4 4 8-8M15 7h6v6" />,
  pen: <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16zM13.5 6.5l4 4" />,
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </>
  ),
  chart: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  flag: <path d="M5 21V4M5 4h12l-2.5 4.5L17 13H5" />,
  brain: <path d="M12 5a3 3 0 0 0-5.6-1.5A3 3 0 0 0 4 8a3 3 0 0 0 0 6 3 3 0 0 0 3 4 3 3 0 0 0 5 1zM12 5a3 3 0 0 1 5.6-1.5A3 3 0 0 1 20 8a3 3 0 0 1 0 6 3 3 0 0 1-3 4 3 3 0 0 1-5 1zM12 5v14" />,
  check: <path d="M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />,
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </>
  ),
};

const sections = [
  {
    label: null,
    items: [
      { href: "/dashboard", label: "Home", icon: "home" },
      { href: "/opportunities", label: "Opportunities", icon: "target" },
      { href: "/activity", label: "Activity", icon: "chat" },
      { href: "/watchlist", label: "Watchlist", icon: "eye" },
      { href: "/discovery", label: "Discovery", icon: "compass" },
    ],
  },
  {
    label: "Grow",
    items: [
      { href: "/leads", label: "Lead Scout", icon: "user" },
      { href: "/crm", label: "CRM", icon: "users" },
      { href: "/trends", label: "Trend Scout", icon: "trend" },
      { href: "/studio", label: "Content Studio", icon: "pen" },
      { href: "/calendar", label: "Calendar", icon: "calendar" },
      { href: "/growth", label: "Growth Intelligence", icon: "chart" },
      { href: "/strategy", label: "Growth Strategy", icon: "flag" },
    ],
  },
  {
    label: "Scout Brain",
    items: [
      { href: "/memory", label: "Memory", icon: "brain" },
      { href: "/eval", label: "Brain eval", icon: "check" },
    ],
  },
];

/** Sidebar navigation with the current section highlighted. */
export function AppNav() {
  return <NavLinks pathname={usePathname()} />;
}

/**
 * The same links without the highlight: the Suspense fallback on dynamic
 * routes (e.g. /opportunities/[id]), where the pathname is only known at request time.
 */
export function NavLinks({ pathname }: { pathname?: string }) {
  const link = (item: { href: string; label: string; icon: string }) => (
    <Link
      key={item.href}
      href={item.href}
      className="app-nav-link"
      data-active={pathname?.startsWith(item.href) || undefined}
      // Closes the mobile drawer (see SidebarToggle)
      onClick={() => document.body.removeAttribute("data-nav-open")}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        {icons[item.icon]}
      </svg>
      {item.label}
    </Link>
  );

  return (
    <nav className="app-nav" aria-label="Primary navigation">
      {sections.map((section) => (
        <div key={section.label ?? "main"} className="app-nav-group">
          {section.label && <p className="app-nav-label">{section.label}</p>}
          {section.items.map(link)}
        </div>
      ))}
      <div className="app-nav-group app-nav-bottom">
        {link({ href: "/account/settings", label: "Settings", icon: "settings" })}
      </div>
    </nav>
  );
}
