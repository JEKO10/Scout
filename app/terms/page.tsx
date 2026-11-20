import type { Metadata } from "next";
import Link from "next/link";

import { LegalPage, Placeholder } from "@/components/marketing/LegalPage";

export const metadata: Metadata = {
  title: "Terms of Service",
  description: "The terms for using Scout during its beta.",
  alternates: { canonical: "/terms" },
};

// DRAFT for review before public launch: not legal advice, not checked by a lawyer.
export default function TermsPage() {
  return (
    <LegalPage title="Terms of Service" updated="November 20, 2026">
      <p className="legal-review">
        Draft for review. Items in brackets must be completed by the operator before public launch.
      </p>

      <h2>1. Who we are</h2>
      <p>
        Scout (&quot;Scout&quot;, &quot;we&quot;) is operated by <Placeholder>legal name of the operator</Placeholder>,{" "}
        <Placeholder>registered address</Placeholder>. Contact: <Placeholder>support email</Placeholder>.
      </p>

      <h2>2. The service</h2>
      <p>
        Scout helps you grow on X. It builds a profile of your interests and writing style (your &quot;Scout
        Brain&quot;) from information you provide and public posts, monitors the public X accounts and topics you
        choose, finds conversations worth joining, and prepares reply and post drafts for you to review. If you
        connect your X account and enable publishing, Scout can also publish posts you approved, now or at a time you
        choose. Scout is in beta: features may change, and the service may be interrupted.
      </p>

      <h2>3. Your account</h2>
      <ul>
        <li>You need an account to use Scout. Keep your login secure; you&apos;re responsible for activity on it.</li>
        <li>Provide accurate information, and only connect an X account that is yours.</li>
        <li>You must be old enough to form a binding contract where you live.</li>
      </ul>

      <h2>4. AI-generated content</h2>
      <p>
        Opportunity scores, explanations, suggestions and drafts are generated with AI. They can be inaccurate,
        incomplete or unsuitable, and Scout may phrase things you wouldn&apos;t. Review every draft before you approve
        or post it, and fill in anything only you know. Whether you post a draft yourself or Scout publishes it after
        your approval, it is your content: you&apos;re responsible for it, and for following X&apos;s rules and
        applicable law.
      </p>

      <h2>5. Publishing to X</h2>
      <ul>
        <li>
          <strong>Optional and separate.</strong> Publishing requires connecting your X account and granting Scout
          X&apos;s publishing permission in a separate step. You can use Scout without it, and copy drafts to X
          yourself.
        </li>
        <li>
          <strong>Your explicit approval.</strong> Scout publishes only the exact text you approved. If the text
          changes after approval, it needs your approval again. Scout doesn&apos;t publish unapproved content, and
          doesn&apos;t reply to other people&apos;s posts, like, repost, quote, follow or send messages for you. To
          reply to someone, Scout opens X&apos;s own composer and you send the reply yourself.
        </li>
        <li>
          <strong>Now or scheduled.</strong> After approving, you choose &quot;Publish now&quot; or a date and time.
          Scheduled posts are sent by our scheduler at or shortly after that time, usually within a few minutes. A
          scheduled post that couldn&apos;t be sent within 6 hours of its time (for example because publishing was
          paused) isn&apos;t sent automatically; you decide what to do with it. Until a post is being sent, you can
          edit it, reschedule it or cancel its schedule.
        </li>
        <li>
          <strong>Confirmation.</strong> A post is shown as published only after X confirms it. If X doesn&apos;t
          answer, Scout checks your profile before anything is sent again, so the same post isn&apos;t published twice.
          You can ask Scout to delete a post it published.
        </li>
        <li>
          <strong>No guarantee of publication.</strong> X may refuse, delay or limit a post (for example duplicate
          content, rate limits, a revoked permission or an outage), and its API, pricing and rules may change. Scout
          tells you when a post wasn&apos;t published. We aren&apos;t responsible for posts X doesn&apos;t publish or
          removes.
        </li>
        <li>
          <strong>Stopping.</strong> You can revoke publishing at any time by disconnecting X in Settings or in your
          X account settings. Disconnecting cancels approved and scheduled posts that haven&apos;t been sent.
        </li>
      </ul>

      <h2>6. Acceptable use</h2>
      <ul>
        <li>Don&apos;t use Scout for spam, harassment, impersonation, deception or automated mass replies.</li>
        <li>
          Don&apos;t use scheduling or publishing to post identical or substantially similar content repeatedly or
          across accounts, or to manipulate trends or engagement.
        </li>
        <li>Don&apos;t try to access other users&apos; data, bypass usage limits or interfere with the service.</li>
        <li>Don&apos;t use Scout in breach of X&apos;s terms, rules and automation rules, or applicable law.</li>
      </ul>
      <p>We may suspend accounts, or publishing for an account, that break these rules.</p>

      <h2>7. Third-party services</h2>
      <p>
        Scout relies on third-party services, including the X API, OpenAI, Slack (if you connect it), Neon, Vercel
        and Paddle. Their availability, terms and limits are outside our control; X can limit or end Scout&apos;s API
        access, which can make reading or publishing unavailable. Scout is not affiliated with or endorsed by X Corp.
      </p>

      <h2>8. Plans, billing and usage limits</h2>
      <p>
        The Free plan costs nothing. Each plan has usage limits (watched accounts, X posts read, AI usage and, where
        offered, posts published from Scout per day or week and a monthly publishing allowance) that Scout enforces
        and may adjust during the beta. Posts with a link cost more on X and use more of the publishing allowance.
        When a limit is reached, Scout stops that action until the limit resets; you can still copy your drafts to X.
        Paid plans, when available, are billed monthly in advance through Paddle, our reseller and Merchant of Record,
        and renew until canceled. You can cancel at any time in Settings; access continues until the end of the paid
        period. Refunds are covered by the <Link href="/refund-policy">Refund Policy</Link>.
      </p>

      <h2>9. Your content and data</h2>
      <p>
        You keep ownership of what you provide and of the posts and replies you publish. You allow us to process it to
        run Scout, including sending posts you approved to X for publishing, as described in the{" "}
        <Link href="/privacy">Privacy Policy</Link>. Other people&apos;s X posts shown in Scout are kept only for a
        limited time and removed when X or their author asks; once removed, Scout shows only a link to the post on X.
      </p>

      <h2>10. Ending your use</h2>
      <p>
        You can stop using Scout at any time, disconnect X in Settings, and delete your account in Settings (cancel a
        paid plan first). Deleting stops scheduled posts and revokes Scout&apos;s access to your X account; the details
        are in the Privacy Policy. Deleting your account doesn&apos;t delete posts already published on X. We may end or suspend
        the service, or your access, with reasonable notice where possible.
      </p>

      <h2>11. Disclaimers and liability</h2>
      <p>
        Scout is provided &quot;as is&quot; during the beta, without warranties of any kind, to the extent permitted
        by law. We don&apos;t guarantee audience growth, engagement, any particular result, or that a post will be
        published at a particular time. <Placeholder>liability limits, to be reviewed by a lawyer</Placeholder>
      </p>

      <h2>12. Changes</h2>
      <p>
        We may update these terms. We&apos;ll post the new version here with a new date and, for material changes,
        tell you in the app or by email.
      </p>

      <h2>13. Governing law</h2>
      <p>
        <Placeholder>governing law and jurisdiction</Placeholder>
      </p>
    </LegalPage>
  );
}
