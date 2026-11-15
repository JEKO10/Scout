import type { Metadata } from "next";
import Link from "next/link";

import { LegalPage, Placeholder } from "@/components/marketing/LegalPage";

export const metadata: Metadata = {
  title: "Contact",
  description: "How to reach the people behind Scout.",
  alternates: { canonical: "/contact" },
};

export default function ContactPage() {
  return (
    <LegalPage title="Contact" updated="November 16, 2026">
      <p>Questions, feedback, bugs, billing or data requests: we read everything during the beta.</p>
      <ul>
        <li>
          Email: <Placeholder>support email</Placeholder>
        </li>
        <li>
          On X: <Placeholder>@handle</Placeholder>
        </li>
        <li>
          Operator: <Placeholder>legal name and address</Placeholder>
        </li>
      </ul>

      <h2>Before you write</h2>
      <ul>
        <li>For billing, include the email address of your Scout account.</li>
        <li>
          To delete your account, see the <Link href="/privacy">Privacy Policy</Link>.
        </li>
        <li>
          Refunds are described in the <Link href="/refund-policy">Refund Policy</Link>.
        </li>
      </ul>
    </LegalPage>
  );
}
