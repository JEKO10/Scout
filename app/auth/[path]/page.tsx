import { AuthView } from "@neondatabase/auth-ui";
import { authViewPaths } from "@neondatabase/auth-ui/server";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";

import { getOptionalUser } from "@/lib/auth/session";

export function generateStaticParams() {
  return Object.values(authViewPaths).map((path) => ({ path }));
}

type Params = PageProps<"/auth/[path]">["params"];

export default function AuthPage({ params, searchParams }: PageProps<"/auth/[path]">) {
  return (
    <main className="auth-page">
      <Link href="/" className="brand auth-brand">
        <span className="brand-mark" aria-hidden="true">S</span>
        <span>Scout</span>
      </Link>
      <section className="auth-layout enter-content">
        <div className="auth-message">
          <p className="eyebrow">Your signal, amplified</p>
          <h1>Spend less time searching. Join better conversations.</h1>
          <p>Sign in to see every opportunity Scout found for you.</p>
        </div>
        <div className="auth-view-shell">
          <Suspense fallback={<div className="skeleton skeleton-auth" />}>
            <AuthContent params={params} searchParams={searchParams} />
          </Suspense>
        </div>
      </section>
    </main>
  );
}

/** Only same-site paths: "/pricing?plan=pro" yes, "//evil.com" or "https://…" no */
function safeRedirect(value: string | string[] | undefined): string {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\")
    ? value
    : "/dashboard";
}

async function AuthContent({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: PageProps<"/auth/[path]">["searchParams"];
}) {
  const { path } = await params;
  if (!(Object.values(authViewPaths) as string[]).includes(path)) notFound();

  // Already signed in: the sign-in and sign-up forms skip straight to the app
  if (path === authViewPaths.SIGN_IN || path === authViewPaths.SIGN_UP) {
    const [user, { redirectTo }] = await Promise.all([getOptionalUser(), searchParams]);
    if (user) redirect(safeRedirect(redirectTo));
  }
  return <AuthView path={path} />;
}
