import type { Metadata } from "next";

import { LegalPage, Placeholder } from "@/components/marketing/LegalPage";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "What Scout collects, why, and the choices you have.",
  alternates: { canonical: "/privacy" },
};

// DRAFT for review before public launch: not legal advice, not checked by a lawyer.
export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy" updated="November 20, 2026">
      <p className="legal-review">
        Draft for review. Items in brackets must be completed by the operator before public launch. This draft
        doesn&apos;t claim compliance with any specific law until that has been verified.
      </p>

      <h2>Who is responsible</h2>
      <p>
        <Placeholder>legal name of the operator</Placeholder>, <Placeholder>registered address</Placeholder>.
        Privacy questions: <Placeholder>privacy contact email</Placeholder>.
      </p>

      <h2>What we collect</h2>
      <ul>
        <li>
          <strong>Account:</strong> your email address and login details, handled by our authentication provider
          (Neon Auth).
        </li>
        <li>
          <strong>What you tell Scout:</strong> onboarding answers (what you do, goals, audience, topics, tone),
          calibration answers, your X handle, reply preferences, rules and settings.
        </li>
        <li>
          <strong>Public X data:</strong> read through the official X API: your own recent public posts (when you
          ask Scout to analyze them), recent public posts from the accounts you choose to monitor and from searches
          for the topics you choose, and the public profiles (bio and follower counts) of accounts you add for
          comparison. When a post looks like a potential customer, Scout keeps it, with its author&apos;s public handle,
          in your lead list.
        </li>
        <li>
          <strong>What Scout produces and what you do with it:</strong> your Scout Brain, opportunity scores and
          explanations, reply and post drafts, earlier versions of drafts you edited or regenerated, your decisions on
          prepared items (approve, decline and the optional reason, snooze), what Scout learned from them, your
          content plan and schedule, and when you opened X&apos;s composer from Scout.
        </li>
        <li>
          <strong>Connected X account (optional):</strong> you can connect your X account through X&apos;s own
          authorization screen. Reading access uses the permissions <code>tweet.read</code>, <code>users.read</code>{" "}
          and <code>offline.access</code>: Scout reads your profile and your posts with their metrics, including
          private ones X shows only to you (impressions, engagements, profile clicks and link clicks, which X provides
          for posts from the last 30 days). Scout keeps daily readings so it can show your progress after that window.
          Scout reads this data only when you ask (an optional one-time import of your last 29 days, and Growth
          refreshes, at most once a day) or on your plan&apos;s automatic schedule if enabled, never more than once a
          day.
        </li>
        <li>
          <strong>Publishing permission (optional, separate; being introduced gradually and not available to every
          account yet):</strong> only if you choose &quot;Enable publishing&quot;
          and allow it on X&apos;s screen, Scout also holds the permission <code>tweet.write</code>. With it, Scout
          publishes on your X account only original posts whose exact text you approved, at the time you chose, and
          deletes a post it published only when you ask. Scout doesn&apos;t use it to reply to other people&apos;s
          posts, like, repost, quote, follow or send messages, and it never reads your direct messages.
        </li>
        <li>
          <strong>X connection details:</strong> your X user ID and handle, the permissions X granted, and an access
          token and refresh token, stored encrypted.
        </li>
        <li>
          <strong>Publishing records:</strong> for each post you approve for publishing, the approved text, when you
          approved it, the scheduled time and time zone if any, its status (scheduled, published, failed, cancelled),
          the post&apos;s ID and link on X once X confirms it, error messages, and the estimated X API cost counted
          against your plan.
        </li>
        <li>
          <strong>Integrations:</strong> if you connect Slack, the workspace, channel and an access token (stored
          encrypted).
        </li>
        <li>
          <strong>Billing:</strong> if you subscribe, Paddle processes your payment. We receive subscription and
          customer identifiers, plan, status and price, never your full card details.
        </li>
        <li>
          <strong>Usage and product analytics:</strong> usage counts we need to enforce plan limits (including X
          reads, AI costs and publishing costs), and first-party product events (for example &quot;onboarding
          completed&quot; or &quot;post published&quot;). These events contain no post or reply text, no Scout Brain
          details, no email and no IP address. We don&apos;t use third-party advertising trackers.
        </li>
      </ul>

      <h2>Why we use it</h2>
      <ul>
        <li>
          To provide Scout: build your Scout Brain, find and score opportunities, prepare and edit drafts, and show
          your growth.
        </li>
        <li>If you enable publishing: to publish or schedule the posts you approved, and to confirm they were published.</li>
        <li>To enforce plan limits, prevent abuse and keep the service reliable.</li>
        <li>To bill paid plans and handle cancellations and refunds.</li>
        <li>To understand, in aggregate, how people use Scout and improve it.</li>
      </ul>
      <p>
        <Placeholder>legal bases for processing, if required in your jurisdiction</Placeholder>
      </p>

      <h2>AI processing</h2>
      <p>
        To score posts, draft and edit replies and posts, and prepare suggestions, Scout sends the relevant parts of
        your profile, your Scout Brain and settings, the posts involved (your own and those from accounts and topics
        you follow) and, when you ask for an edit, the current draft and your instruction to OpenAI&apos;s API. Where automatic preparation
        is available and you turn it on, Scout does this on its own within your plan&apos;s limits. AI output can be
        wrong: you review and approve what is published.
      </p>
      <p>
        Scout doesn&apos;t train or fine-tune AI models with your data or with X content. Scout asks OpenAI not to store
        its responses for later retrieval, and uses no OpenAI features that keep data between requests (no stored
        conversations, files or vector stores). OpenAI processes this data as our service provider under its API terms
        and data usage policies, which may include keeping it for a limited time.{" "}
        <Placeholder>verified statement on OpenAI&apos;s retention and training use of API data, matching Scout&apos;s OpenAI account settings</Placeholder>
      </p>

      <h2>Who we share it with</h2>
      <p>Service providers that run Scout for us, only as needed:</p>
      <ul>
        <li>Neon (database and authentication), Vercel (hosting)</li>
        <li>OpenAI (AI scoring, drafting and editing)</li>
        <li>
          X (reading posts through the X API; with your consent, your own private post metrics; and, only if you enable
          publishing, the posts you approved)
        </li>
        <li>Slack (only if you connect it, to deliver alerts)</li>
        <li>Paddle (payments, as Merchant of Record for paid plans)</li>
      </ul>
      <p>
        Posts Scout publishes for you are public on X like any other post. We don&apos;t sell your personal data and
        don&apos;t use your X metrics for advertising. Some providers may process data outside your country.
      </p>

      <h2>Retention and deletion</h2>
      <p>
        Other people&apos;s X content is kept only for a limited time. After that, Scout keeps only the post&apos;s ID and
        link:
      </p>
      <ul>
        <li>
          Posts Scout read from accounts and topics you follow, and the opportunities found in them: 30 days after they
          were posted.
        </li>
        <li>Posts behind leads in your lead list: 90 days after they were posted. The lead, its status and your notes stay.</li>
        <li>Short excerpts of posts in automation notifications and review items: 30 days.</li>
        <li>
          The shared cache of posts from monitored accounts: 14 days after they were posted, unless one is still linked
          to an opportunity.
        </li>
      </ul>
      <p>
        When X or the author asks us to remove a post, or X tells us it was deleted, made private or suspended, Scout
        removes its stored text. Scout doesn&apos;t learn about every deletion on X right away: until it does, or until the
        periods above end, a copy can remain in Scout.
      </p>
      <p>Other data deleted automatically:</p>
      <ul>
        <li>Records of finished background jobs: 30 days.</li>
        <li>Statistics about accounts you compare with: 90 days after the post they describe.</li>
        <li>Automation history, closed review items and read notifications: 90 days.</li>
        <li>Product analytics events: about 13 months (400 days).</li>
      </ul>
      <p>
        Everything else, including your drafts, your own posts and metric readings, and publishing records, is kept
        while your account exists, unless you delete it in Scout. Billing records are kept as required for tax and
        accounting. Encrypted copies of the database made before maintenance are kept for{" "}
        <Placeholder>backup retention period</Placeholder> and then deleted.
      </p>
      <p>
        You can delete your account in Settings. If you have a paid plan, cancel it first. Deleting stops everything
        Scout does for you (scans, automations, scheduled posts), revokes Scout&apos;s access to your X account,
        disconnects Slack, and deletes the data stored with your account and then your login. If a step can&apos;t be
        completed (for example X doesn&apos;t confirm the revocation), Scout tells you, keeps all processing for your
        account stopped, and you can try again; the deletion isn&apos;t reported as done until every step is. Afterwards
        Scout keeps a short record that the account was deleted (the sign-in ID and which steps were completed, without
        content) for 30 days. Product analytics events stay without any link to you. Paddle keeps its own billing
        records as Merchant of Record. Deleting your account doesn&apos;t delete posts already published on X, and
        doesn&apos;t remove your data from backups before they expire.
      </p>

      <h2>Your choices</h2>
      <ul>
        <li>Review and edit your Scout Brain, answers, preferences and what Scout learned in Settings.</li>
        <li>
          Remove monitored accounts, disconnect Slack or turn off automatic scans (and automatic preparation, where
          available) at any time.
        </li>
        <li>
          Nothing is published without your approval of its exact text. Until a post is being sent, you can edit it
          (which requires approving it again), reschedule it or cancel its schedule.
        </li>
        <li>Where publishing is available, you can delete a post Scout published from X, from within Scout.</li>
        <li>
          Disconnect your X account at any time in Settings: Scout revokes its access at X, deletes the tokens and
          cancels all approved and scheduled posts that haven&apos;t been sent. A post X is already processing at that
          moment can still be completed and recorded. Your stored posts, follower readings and publishing records stay
          in Scout; if you choose, Scout also deletes the private metrics it stored. You can also revoke Scout&apos;s
          access in your X account settings; Scout then stops using the connection the next time it tries.
        </li>
        <li>Delete your account and its data in Settings.</li>
        <li>
          Ask for a copy of your data, a correction, or help with a deletion: <Placeholder>support email</Placeholder>.
        </li>
      </ul>

      <h2>Security</h2>
      <p>
        Data is sent over HTTPS. Access and refresh tokens are encrypted (AES-256-GCM) before they&apos;re stored,
        are used only on Scout&apos;s servers and are never sent to your browser. Database backups are encrypted
        (AES-256-GCM) with a key kept separately from them. Each user can only access their own data. No system is perfectly secure; tell us at <Placeholder>security contact</Placeholder> if you find a
        problem.
      </p>

      <h2>Cookies</h2>
      <p>
        Scout uses the cookies needed to keep you signed in, and a short-lived, encrypted cookie (at most 10 minutes)
        that secures the X connection step. It doesn&apos;t use advertising or cross-site tracking cookies.
      </p>

      <h2>Changes</h2>
      <p>We&apos;ll post updates here with a new date and tell you about material changes.</p>
    </LegalPage>
  );
}
