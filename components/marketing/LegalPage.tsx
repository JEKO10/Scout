import Link from "next/link";
import type { ReactNode } from "react";

import { Logo } from "@/components/Logo";

import { SiteFooter } from "./SiteFooter";

/** Shared layout of the public legal and trust pages */
export function LegalPage({ title, updated, children }: { title: string; updated: string; children: ReactNode }) {
  return (
    <main className="landing-page">
      <nav className="landing-nav shell" aria-label="Main navigation">
        <Logo />
        <div>
          <Link href="/pricing" className="nav-text-link">Pricing</Link>
          <Link href="/auth/sign-up" className="small-dark-button">Start for Free</Link>
        </div>
      </nav>
      <article className="legal-page shell">
        <p className="eyebrow">Last updated: {updated}</p>
        <h1>{title}</h1>
        {children}
      </article>
      <SiteFooter />
    </main>
  );
}

/** Business details not decided yet: visible on the page, easy to find before launch */
export function Placeholder({ children }: { children: ReactNode }) {
  return <mark className="legal-placeholder">[{children}]</mark>;
}
