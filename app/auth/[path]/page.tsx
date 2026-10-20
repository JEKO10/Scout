import { AuthView } from "@neondatabase/auth-ui";
import { authViewPaths } from "@neondatabase/auth-ui/server";
import { notFound } from "next/navigation";
import { Suspense } from "react";

export function generateStaticParams() {
  return Object.values(authViewPaths).map((path) => ({ path }));
}

type Params = PageProps<"/auth/[path]">["params"];

export default function AuthPage({ params }: PageProps<"/auth/[path]">) {
  return (
    <main className="flex grow flex-col items-center justify-center p-4">
      <Suspense>
        <AuthContent params={params} />
      </Suspense>
    </main>
  );
}

async function AuthContent({ params }: { params: Params }) {
  const { path } = await params;
  if (!(Object.values(authViewPaths) as string[]).includes(path)) notFound();

  return <AuthView path={path} />;
}
