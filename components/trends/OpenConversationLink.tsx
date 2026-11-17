"use client";

import type { ReactNode } from "react";

import { trendConversationOpenedAction } from "@/actions/trends";

/** A link to a trend's conversation (in Scout or on X) that records the open */
export function OpenConversationLink({ trendId, href, external, children }: { trendId: string; href: string; external?: boolean; children: ReactNode }) {
  return (
    <a
      href={href}
      className="text-link"
      {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
      onClick={() => void trendConversationOpenedAction(trendId)}
    >
      {children}
    </a>
  );
}
