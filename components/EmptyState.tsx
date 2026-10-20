import Link from "next/link";

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: { href: string; label: string };
}) {
  return (
    <div className="empty-state">
      <span className="empty-state-mark" aria-hidden="true" />
      <h3>{title}</h3>
      <p>{description}</p>
      {action && (
        <Link href={action.href} className="text-link">
          {action.label} <span aria-hidden="true">→</span>
        </Link>
      )}
    </div>
  );
}
