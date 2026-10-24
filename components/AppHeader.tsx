"use client";

import { UserButton } from "@neondatabase/auth-ui";
import Link from "next/link";
import { usePathname } from "next/navigation";

const navigation = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/eval", label: "Brain eval" },
  { href: "/account/settings", label: "Settings" },
];

export function AppHeader() {
  const pathname = usePathname();

  return (
    <header className="app-header">
      <div className="app-header-inner">
        <Link href="/dashboard" className="brand" aria-label="Scout dashboard">
          <span className="brand-mark" aria-hidden="true">
            S
          </span>
          <span>Scout</span>
        </Link>

        <nav className="app-nav" aria-label="Primary navigation">
          {navigation.map((item) => {
            const active = pathname.startsWith(item.href);
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

        <UserButton
          align="end"
          additionalLinks={[
            { href: "/dashboard", label: "Dashboard" },
            { href: "/account/settings", label: "Scout settings" },
          ]}
        />
      </div>
    </header>
  );
}
