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
    <LegalPage title="Privacy Policy" updated="November 18, 2026">
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
          calibration answers, your X handle, reply preferences and settings.
        </li>
        <li>
          <strong>Public X data:</strong> your own recent public posts (when you ask Scout to analyze them), and
          recent public posts from the accounts you choose to monitor, read through the official X API.
        </li>
        <li>
          <strong>What Scout produces:</strong> your Scout Brain, opportunity scores and explanations, reply drafts,
          and when you opened X&apos;s composer from Scout.
        </li>
        <li>
          <strong>Connected X account (optional):</strong> if you connect your X account, you authorize Scout through
          X to read your profile and your posts, read-only (permissions <code>tweet.read</code>,{" "}
          <code>users.read</code>, <code>offline.access</code>). Scout can&apos;t post, like, follow or read your
          messages. Scout stores your X user ID and handle, an access token and refresh token (encrypted), and your
          posts&apos; metrics, including private ones X shows only to you: impressions, engagements, profile clicks
          and link clicks, which X provides for posts from the last 30 days. Scout keeps daily readings so it can show
          your progress after that window. Scout reads this data only when you ask (an optional one-time import of your last 29
          days, and Growth refreshes, at most once a day) or on your plan&apos;s automatic schedule if enabled, never more than
          once a day.
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
          <strong>Usage and product analytics:</strong> usage counts we need to enforce plan limits, and first-party
          product events (for example &quot;onboarding completed&quot; or &quot;pricing page viewed&quot;). These
          events contain no post or reply text, no Scout Brain details, no email and no IP address. We don&apos;t use
          third-party advertising trackers.
        </li>
      </ul>

      <h2>Why we use it</h2>
      <ul>
        <li>To provide Scout: build your Scout Brain, find and score opportunities, and draft replies.</li>
        <li>To enforce plan limits, prevent abuse and keep the service reliable.</li>
        <li>To bill paid plans and handle cancellations and refunds.</li>
        <li>To understand, in aggregate, how people use Scout and improve it.</li>
      </ul>
      <p>
        <Placeholder>legal bases for processing, if required in your jurisdiction</Placeholder>
      </p>

      <h2>AI processing</h2>
      <p>
        To score posts and draft replies, Scout sends relevant parts of your profile, your Scout Brain and the posts
        involved to OpenAI&apos;s API. AI output can be wrong; you decide what to post.
      </p>

      <h2>Who we share it with</h2>
      <p>Service providers that run Scout for us, only as needed:</p>
      <ul>
        <li>Neon (database and authentication), Vercel (hosting)</li>
        <li>OpenAI (AI scoring and reply drafts)</li>
        <li>X (reading public posts through the X API and, with your consent, your own private post metrics)</li>
        <li>Slack (only if you connect it, to deliver alerts)</li>
        <li>Paddle (payments, as Merchant of Record for paid plans)</li>
      </ul>
      <p>
        We don&apos;t sell your personal data and don&apos;t use your X metrics for advertising. Some providers may process data outside your country.
      </p>

      <h2>Retention and deletion</h2>
      <p>
        We keep your data while your account exists. Cached posts from monitored accounts are deleted automatically
        once Scout no longer needs them. Billing records are kept as required for tax and accounting.{" "}
        <Placeholder>specific retention periods</Placeholder>
      </p>
      <p>
        To delete your account and its data, contact <Placeholder>support email</Placeholder>. We&apos;ll confirm
        when it&apos;s done. <Placeholder>deletion timeframe</Placeholder>
      </p>

      <h2>Your choices</h2>
      <ul>
        <li>Review and edit your Scout Brain, answers and preferences in Settings.</li>
        <li>Remove monitored accounts, disconnect Slack or turn off automatic scans at any time.</li>
        <li>
          Disconnect your X account at any time in Settings: Scout revokes its access at X and deletes the tokens, and
          if you choose, also deletes the private metrics it stored. Deleting your Scout account deletes all of it.
        </li>
        <li>
          Ask for a copy of your data, a correction or deletion: <Placeholder>support email</Placeholder>.
        </li>
      </ul>

      <h2>Security</h2>
      <p>
        Data is sent over HTTPS, access tokens are stored encrypted, and each user can only access their own data.
        No system is perfectly secure; tell us at <Placeholder>security contact</Placeholder> if you find a problem.
      </p>

      <h2>Cookies</h2>
      <p>
        Scout uses the cookies needed to keep you signed in. It doesn&apos;t use advertising or cross-site tracking
        cookies.
      </p>

      <h2>Changes</h2>
      <p>We&apos;ll post updates here with a new date and tell you about material changes.</p>
    </LegalPage>
  );
}
