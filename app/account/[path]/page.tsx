import { AccountView } from "@neondatabase/auth-ui";
import { accountViewPaths } from "@neondatabase/auth-ui/server";
import { notFound } from "next/navigation";
import { Suspense } from "react";

export function generateStaticParams() {
  return Object.values(accountViewPaths).map((path) => ({ path }));
}

type Params = PageProps<"/account/[path]">["params"];

export default function AccountPage({ params }: PageProps<"/account/[path]">) {
  return (
    <main className="container mx-auto p-4 md:p-6">
      <Suspense>
        <AccountContent params={params} />
      </Suspense>
    </main>
  );
}

async function AccountContent({ params }: { params: Params }) {
  const { path } = await params;
  if (!(Object.values(accountViewPaths) as string[]).includes(path))
    notFound();

  return <AccountView path={path} />;
}
