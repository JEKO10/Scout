import Link from "next/link";

import { Logo } from "@/components/Logo";

/** Public pages: product and legal links */
export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-footer-inner mk-shell">
        <div className="site-footer-brand">
          <Logo height={28} />
          <p>Find opportunities. Create. Grow.</p>
        </div>
        <nav aria-label="Product">
          <h2>Product</h2>
          <Link href="/#features">Features</Link>
          <Link href="/#how-it-works">How it works</Link>
          <Link href="/pricing">Pricing</Link>
        </nav>
        <nav aria-label="Company">
          <h2>Company</h2>
          <Link href="/contact">Contact</Link>
          <Link href="/terms">Terms</Link>
          <Link href="/privacy">Privacy</Link>
          <Link href="/refund-policy">Refund policy</Link>
        </nav>
      </div>
      <p className="site-footer-note mk-shell">
        Scout is in beta. X is a trademark of X Corp.; Scout isn&apos;t affiliated with X.
      </p>
    </footer>
  );
}
