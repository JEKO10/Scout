import type { ReactNode } from "react";

/**
 * A small "i" button that reveals an explanation on click, so long
 * descriptions don't take up room on the page. Native <details>: works
 * without JavaScript and is keyboard accessible.
 *
 * With `text`, the button also shows a short visible label (e.g. "How this
 * works"), for explanations that sit on their own line instead of next to a title.
 */
export function InfoHint({ children, label = "More info", text }: { children: ReactNode; label?: string; text?: string }) {
  return (
    <details className="info-hint" data-text={text ? "" : undefined}>
      <summary aria-label={text ? undefined : label} title={text ? undefined : label}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v5M12 8h.01" />
        </svg>
        {text}
      </summary>
      <div className="info-hint-body" role="note">
        {children}
      </div>
    </details>
  );
}

/** A page or section title with its explanation tucked into an InfoHint */
export function TitleWithHint({
  as: Tag = "h1",
  id,
  title,
  hint,
}: {
  as?: "h1" | "h2" | "h3";
  id?: string;
  title: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div className="title-with-hint">
      <Tag id={id}>{title}</Tag>
      {hint && <InfoHint label="About this">{hint}</InfoHint>}
    </div>
  );
}
