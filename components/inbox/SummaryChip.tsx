import type { InboxItemType } from "@/lib/inbox/types";

const PATHS: Record<InboxItemType, string> = {
  reply: "M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z",
  post: "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h5",
  conversation: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10z",
  lead: "M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4 21a8 8 0 0 1 16 0",
  recommendation: "M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3M7.5 15h9",
  reminder: "M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0",
  publish: "M22 2 11 13M22 2l-7 20-4-9-9-4z",
};

/** "1 reply", "1 post": counted from the cards below */
export function SummaryChip({ type, label }: { type: InboxItemType; label: string }) {
  return (
    <li className="inbox-count" data-type={type}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d={PATHS[type]} />
      </svg>
      {label}
    </li>
  );
}
