import Link from "next/link";

export default function Home() {
  return (
    <main className="landing-page">
      <nav className="landing-nav shell" aria-label="Main navigation">
        <Link href="/" className="brand" aria-label="Scout home">
          <span className="brand-mark" aria-hidden="true">S</span>
          <span>Scout</span>
        </Link>
        <div>
          <Link href="/auth/sign-in" className="nav-text-link">Sign in</Link>
          <Link href="/auth/sign-up" className="small-dark-button">Start scouting</Link>
        </div>
      </nav>

      <section className="landing-hero shell">
        <div className="hero-copy enter-content">
          <p className="eyebrow">AI growth operator for X</p>
          <h1>Find the conversations worth joining.</h1>
          <p>
            Scout learns your voice, watches the right people and surfaces the
            posts where your perspective matters.
          </p>
          <div className="hero-actions">
            <Link href="/auth/sign-up" className="primary-button">Get started</Link>
            <Link href="/auth/sign-in" className="text-link">
              Open your dashboard <span aria-hidden="true">→</span>
            </Link>
          </div>
        </div>

        <div className="signal-visual" aria-hidden="true">
          <div className="signal-ring signal-ring-one" />
          <div className="signal-ring signal-ring-two" />
          <div className="signal-ring signal-ring-three" />
          <div className="signal-core"><span>S</span></div>
          <div className="signal-person signal-person-one"><span>A</span><small>94</small></div>
          <div className="signal-person signal-person-two"><span>E</span><small>89</small></div>
          <div className="signal-person signal-person-three"><span>D</span><small>86</small></div>
          <p>High-signal conversations, ranked for you.</p>
        </div>
      </section>

      <section className="landing-proof shell">
        <p>One focused workflow</p>
        <div>
          <article><span>01</span><h2>Learns your point of view</h2><p>Your posts become context, not generic prompts.</p></article>
          <article><span>02</span><h2>Watches the right accounts</h2><p>Scout scans the people and topics you care about.</p></article>
          <article><span>03</span><h2>Ranks the best openings</h2><p>See why each conversation fits before you engage.</p></article>
        </div>
      </section>
    </main>
  );
}
