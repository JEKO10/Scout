"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { markNotificationsReadAction } from "@/actions/notifications";

export type NotificationItem = {
  id: string;
  opportunityId: string;
  read: boolean;
  author: string;
  preview: string;
  score: number;
  timeLabel: string;
};

export function NotificationMenu({ unread, items }: { unread: number; items: NotificationItem[] }) {
  const [open, setOpen] = useState(false);
  const [readIds, setReadIds] = useState<Set<string>>(new Set());
  const [allRead, setAllRead] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const isRead = (item: NotificationItem) => allRead || item.read || readIds.has(item.id);
  // Unread items beyond the visible list still count until "Mark all as read"
  const count = allRead
    ? 0
    : Math.max(0, unread - items.filter((item) => !item.read && readIds.has(item.id)).length);

  function markRead(item: NotificationItem) {
    setOpen(false);
    if (isRead(item)) return;
    setReadIds((previous) => new Set(previous).add(item.id));
    void markNotificationsReadAction(item.id);
  }

  function markAllRead() {
    setAllRead(true);
    void markNotificationsReadAction();
  }

  return (
    <div className="notification-menu" ref={root}>
      <button
        type="button"
        className="notification-bell"
        aria-label={count ? `Notifications, ${count} unread` : "Notifications"}
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen((value) => !value)}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path
            d="M6 10a6 6 0 1 1 12 0c0 4.5 1.5 6 2 6.5H4c.5-.5 2-2 2-6.5ZM10 19.5a2 2 0 0 0 4 0"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        {count > 0 && <span className="notification-count">{count > 9 ? "9+" : count}</span>}
      </button>

      {open && (
        <div className="notification-panel" role="dialog" aria-label="Notifications">
          <div className="notification-panel-head">
            <strong>Notifications</strong>
            {count > 0 && (
              <button type="button" className="notification-mark-all" onClick={markAllRead}>
                Mark all as read
              </button>
            )}
          </div>
          {items.length === 0 ? (
            <p className="notification-empty">
              Strong opportunities from automatic scans show up here.
            </p>
          ) : (
            <ul className="notification-list">
              {items.map((item) => (
                <li key={item.id}>
                  <Link
                    href={`/opportunities/${item.opportunityId}`}
                    className="notification-item"
                    data-unread={!isRead(item) || undefined}
                    onClick={() => markRead(item)}
                  >
                    <span className="notification-item-head">
                      <strong>{item.author}</strong>
                      <span>
                        {item.score}/100 · {item.timeLabel}
                      </span>
                    </span>
                    <span className="notification-item-text">{item.preview}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <Link href="/opportunities" className="notification-footer" onClick={() => setOpen(false)}>
            All opportunities
          </Link>
        </div>
      )}
    </div>
  );
}
