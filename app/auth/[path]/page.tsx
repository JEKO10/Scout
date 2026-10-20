import { AuthView } from "@neondatabase/auth-ui";
import { authViewPaths } from "@neondatabase/auth-ui/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

export function generateStaticParams() {
  return Object.values(authViewPaths).map((path) => ({ path }));
}

type Params = PageProps<"/auth/[path]">["params"];

export default function AuthPage({ params }: PageProps<"/auth/[path]">) {
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
            <AuthContent params={params} />
          </Suspense>
        </div>
      </section>
    </main>
  );
}

async function AuthContent({ params }: { params: Params }) {
  const { path } = await params;
  if (!(Object.values(authViewPaths) as string[]).includes(path)) notFound();
  return <AuthView path={path} />;
}
