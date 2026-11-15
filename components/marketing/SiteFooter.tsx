import Link from "next/link";

/** Public pages: product and legal links */
export function SiteFooter() {
  return (
    <footer className="site-footer shell">
      <Link href="/" className="brand" aria-label="Scout home">
        <span className="brand-mark" aria-hidden="true">S</span>
        <span>Scout</span>
      </Link>
      <nav aria-label="Footer">
        <Link href="/pricing">Pricing</Link>
        <Link href="/terms">Terms</Link>
        <Link href="/privacy">Privacy</Link>
        <Link href="/refund-policy">Refund policy</Link>
        <Link href="/contact">Contact</Link>
      </nav>
      <p>Scout is in beta. X is a trademark of X Corp.; Scout isn&apos;t affiliated with X.</p>
    </footer>
  );
}
