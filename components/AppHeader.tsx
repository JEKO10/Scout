import { UserButton } from "@neondatabase/auth-ui";
import Link from "next/link";
import { Suspense } from "react";

import { AppNav, NavLinks } from "./AppNav";
import { NotificationBell } from "./notifications/NotificationBell";

// Server Component: the bell reads the user's notifications on the server,
// streamed in its own Suspense boundary so the header never waits for it.
export function AppHeader() {
  return (
    <header className="app-header">
      <div className="app-header-inner">
        <Link href="/dashboard" className="brand" aria-label="Scout dashboard">
          <span className="brand-mark" aria-hidden="true">
            S
          </span>
          <span>Scout</span>
        </Link>

        <Suspense fallback={<NavLinks />}>
          <AppNav />
        </Suspense>

        <div className="app-header-actions">
          <Suspense fallback={<span className="notification-bell-placeholder" aria-hidden="true" />}>
            <NotificationBell />
          </Suspense>
          <UserButton
            // Explicit: the default changed upstream; this keeps avatar + name + email
            size="default"
            align="end"
            additionalLinks={[
              { href: "/dashboard", label: "Dashboard" },
              { href: "/account/settings", label: "Scout settings" },
            ]}
          />
        </div>
      </div>
    </header>
  );
}
