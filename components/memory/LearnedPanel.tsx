import { formatRelative } from "@/lib/format";
import type { LearnedItem, LearningProfile } from "@/lib/scout/learning";
import { RELEARN_EVERY } from "@/services/learning/learnFromHistory";

import { ThatsWrongButton, UpdateLearningButton } from "./LearningControls";

/** "What Scout has learned", each conclusion with its evidence and a way to correct it. */
export function LearnedPanel({
  learning,
  interactionCount,
}: {
  learning: LearningProfile | null;
  interactionCount: number;
}) {
  const sinceUpdate = interactionCount - (learning?.interactionsAtUpdate ?? 0);

  return (
    <section className="learned-panel" aria-labelledby="learned-title">
      <header>
        <div>
          <p className="eyebrow">
            {learning
              ? `Updated ${formatRelative(new Date(learning.updatedAt))} · ${sinceUpdate} new interactions since (auto-updates every ${RELEARN_EVERY})`
              : "Nothing learned yet"}
          </p>
          <h2 id="learned-title">What Scout has learned</h2>
        </div>
        <UpdateLearningButton />
      </header>

      {learning ? (
        <div className="learned-grid">
          <LearnedGroup
            title="Writing"
            items={[
              learning.preferredReplyLength,
              learning.variantPreference,
              ...learning.stylePreferences,
              ...learning.styleAvoidances.map((item) => ({ ...item, label: `Avoids: ${item.label}` })),
            ]}
          />
          <LearnedGroup
            title="Topics"
            items={[
              ...learning.preferredTopics.map((item) => ({ ...item, label: `↑ ${item.label}` })),
              ...learning.avoidedTopics.map((item) => ({ ...item, label: `↓ ${item.label}` })),
            ]}
          />
          <LearnedGroup title="People" items={learning.preferredAccounts} />
          <LearnedGroup
            title="Arguments to stop repeating"
            items={learning.overusedAngles.map((item) => ({ ...item, label: `“${item.label}”` }))}
          />
        </div>
      ) : (
        <p className="memory-note">
          Scout learns from repeated behavior: edit, copy, regenerate and skip a few
          replies, then update learning.
        </p>
      )}
    </section>
  );
}

function LearnedGroup({
  title,
  items,
}: {
  title: string;
  items: (LearnedItem | null)[];
}) {
  const present = items.filter((item): item is LearnedItem => item !== null);
  return (
    <div className="learned-group">
      <h3>{title}</h3>
      {present.length ? (
        <ul>
          {present.map((item) => (
            <li key={item.key} data-strength={item.strength}>
              <div>
                <strong>{item.label}</strong>
                <span>
                  {item.evidence} · {item.strength}
                </span>
              </div>
              <ThatsWrongButton itemKey={item.key} label={item.label} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="memory-note">No repeated pattern yet.</p>
      )}
    </div>
  );
}
