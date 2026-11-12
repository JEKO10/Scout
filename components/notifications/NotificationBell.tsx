import { countUnreadNotifications, getRecentNotifications } from "@/db/queries/notifications";
import { requireProfile } from "@/lib/auth/session";
import { formatRelative } from "@/lib/format";

import { NotificationMenu } from "./NotificationMenu";

/** In-app notification history: strong opportunities from automatic scans. */
export async function NotificationBell() {
  const { profile } = await requireProfile();
  const [unread, recent] = await Promise.all([
    countUnreadNotifications(profile.id),
    getRecentNotifications(profile.id, 8),
  ]);

  return (
    <NotificationMenu
      unread={unread}
      items={recent.map((item) => ({
        id: item.id,
        opportunityId: item.opportunityId,
        read: item.readAt !== null,
        author: item.authorHandle ? `@${item.authorHandle}` : "Someone you watch",
        preview: item.content.length > 120 ? `${item.content.slice(0, 119)}…` : item.content,
        score: Math.round(item.score ?? 0),
        // Formatted on the server, so the client renders the same text it hydrates
        timeLabel: formatRelative(item.createdAt),
      }))}
    />
  );
}
