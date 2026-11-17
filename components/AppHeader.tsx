import { UserButton } from "@neondatabase/auth-ui";
import { Suspense } from "react";

import { AppNav, NavLinks } from "./AppNav";
import { FeedbackButton } from "./feedback/FeedbackButton";
import { Logo } from "./Logo";
import { NotificationBell } from "./notifications/NotificationBell";
import { SidebarBackdrop, SidebarToggle } from "./SidebarToggle";

// Server Component: the left sidebar (navigation) and the top bar (actions).
// The bell reads the user's notifications on the server, streamed in its own
// Suspense boundary so the header never waits for it.
export function AppHeader() {
  return (
    <>
      <aside id="app-sidebar" className="app-sidebar">
        <Logo href="/dashboard" height={28} className="app-sidebar-brand" />
        <Suspense fallback={<NavLinks />}>
          <AppNav />
        </Suspense>
      </aside>
      <SidebarBackdrop />

      <header className="app-header">
        <div className="app-header-inner">
          <SidebarToggle />
          <Logo href="/dashboard" height={24} className="app-header-brand" />
          <div className="app-header-actions">
            <FeedbackButton />
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
    </>
  );
}
