import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { DeleteAccount } from "@/components/account/DeleteAccount";
import { LegalPage } from "@/components/marketing/LegalPage";
import { getDeletionByUserId } from "@/db/queries/accountDeletions";
import { getOptionalUser } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Account deletion", robots: { index: false } };

/** Where a deleted (or being deleted) account lands: what's done, and what isn't yet */
export default function AccountDeletedPage() {
  return (
    <Suspense fallback={null}>
      <Status />
    </Suspense>
  );
}

async function Status() {
  const user = await getOptionalUser();
  const record = user ? await getDeletionByUserId(user.id) : undefined;
  const done = !record || record.status === "completed";
  return (
    <LegalPage title={done ? "Your account was deleted" : "Your account deletion isn't finished"} updated={null}>
      {done ? (
        <p>
          Your Scout account and the data stored with it are deleted. Posts you published on X stay on X. <Link href="/">Back to Scout</Link>
        </p>
      ) : (
        <>
          <p>{record.error ?? "Your deletion is in progress."}</p>
          <p>
            Nothing is processed for your account meanwhile: no scans, automations or scheduled posts.
            {record.steps.dataDeleted ? " Your Scout data is already deleted." : " Your data hasn't been deleted yet."}
          </p>
          <DeleteAccount retry />
        </>
      )}
    </LegalPage>
  );
}
