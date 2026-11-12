"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const navigation = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/opportunities", label: "Opportunities" },
  { href: "/activity", label: "Activity" },
  { href: "/watchlist", label: "Watchlist" },
  { href: "/eval", label: "Brain eval" },
  { href: "/memory", label: "Memory" },
  { href: "/account/settings", label: "Settings" },
];

/** Primary navigation with the current section highlighted. */
export function AppNav() {
  return <NavLinks pathname={usePathname()} />;
}

/**
 * The same links without the highlight: the Suspense fallback on dynamic
 * routes (e.g. /opportunities/[id]), where the pathname is only known at request time.
 */
export function NavLinks({ pathname }: { pathname?: string }) {
  return (
    <nav className="app-nav" aria-label="Primary navigation">
      {navigation.map((item) => {
        const active = pathname?.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className="app-nav-link"
            data-active={active || undefined}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
