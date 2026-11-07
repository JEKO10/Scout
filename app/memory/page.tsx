import { redirect } from "next/navigation";
import { Suspense } from "react";

import { AppHeader } from "@/components/AppHeader";
import { LearnedPanel } from "@/components/memory/LearnedPanel";
import { requireProfile } from "@/lib/auth/session";
import { formatRelative } from "@/lib/format";
import { refreshLearning } from "@/services/learning/refreshLearning";
import {
  type MemoryPreference,
  MIN_REPEATS,
  type TopicCount,
} from "@/services/memory/buildUserMemory";

// Development view: what Scout remembers, exactly as the Reply Engine gets it.

export default function MemoryPage() {
  return (
    <div className="app-page">
      <AppHeader />
      <Suspense
        fallback={
          <main className="workspace shell" aria-busy="true">
            <div className="skeleton skeleton-title" />
          </main>
        }
      >
        <Memory />
      </Suspense>
    </div>
  );
}

async function Memory() {
  const { profile } = await requireProfile();
  if (!profile.onboardingCompleted) redirect("/onboarding");
  // Same entry point the engines use: re-learns when ~10 new interactions piled up
  const { memory, learning } = await refreshLearning(profile.id);
  const { counts } = memory;

  return (
    <main className="workspace shell enter-content">
      <section className="workspace-heading">
        <div>
          <p className="eyebrow">Scout memory · last {memory.windowDays} days</p>
          <h1>What Scout remembers.</h1>
          <p className="lede">
            Built from what you accepted, edited and skipped. A pattern only counts once
            it repeats {MIN_REPEATS}+ times.
          </p>
        </div>
      </section>

      <LearnedPanel learning={learning} interactionCount={memory.interactionCount} />

      <section className="metrics-strip" aria-label="Reply history">
        <Metric value={counts.generated} label="Replies generated" />
        <Metric value={counts.accepted} label="Accepted (copied)" />
        <Metric value={counts.edited} label="Edited" />
        <Metric value={counts.rejected} label="Rejected" />
      </section>

      <div className="memory-grid">
        <MemorySection title="Reply preferences" eyebrow="From your edits and picks">
          <PreferenceList items={memory.preferences} empty="No repeated pattern yet." />
          <p className="memory-note">
            Picked: Natural {memory.variants.natural} · Stronger take{" "}
            {memory.variants.strongerTake}
          </p>
        </MemorySection>

        <MemorySection title="Rejected styles" eyebrow="From drafts you threw away">
          <PreferenceList items={memory.rejectedStyles} empty="Nothing rejected repeatedly yet." />
        </MemorySection>

        <MemorySection title="Topics" eyebrow="Replied or saved · skipped">
          <TopicList label="Engaged" items={memory.topics.engaged} />
          <TopicList label="Skipped" items={memory.topics.dismissed} />
        </MemorySection>

        <MemorySection title="People" eyebrow="Who you replied to">
          {memory.people.length ? (
            <ul className="memory-list">
              {memory.people.map((person) => (
                <li key={person.handle}>
                  <strong>@{person.handle}</strong>
                  <span>
                    {person.interactions}{" "}
                    {person.interactions === 1 ? "interaction" : "interactions"}
                    {person.today ? ` · ${person.today} today` : ""}
                    {person.relationship === "over_engaged" ? " · over-engaged" : ""}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="memory-note">No replies copied yet.</p>
          )}
        </MemorySection>
      </div>

      <MemorySection title="Arguments already used" eyebrow="Scout avoids repeating these">
        {memory.arguments.length ? (
          <ul className="memory-list memory-quotes">
            {memory.arguments.slice(0, 10).map((argument) => (
              <li key={`${argument.at.toISOString()}-${argument.text.slice(0, 20)}`}>
                <p>“{argument.text}”</p>
                <span>
                  @{argument.authorHandle} · {formatRelative(argument.at)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="memory-note">Copy a reply and its argument shows up here.</p>
        )}
      </MemorySection>

      <MemorySection title="Recent edits" eyebrow="Scout's draft → what you kept">
        {memory.editExamples.length ? (
          <ul className="memory-list memory-edits">
            {memory.editExamples.map((edit) => (
              <li key={edit.original}>
                <p className="memory-before">{edit.original}</p>
                <p className="memory-after">{edit.final}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="memory-note">
            No accepted edits yet. Edit a draft before copying it to teach Scout your style.
          </p>
        )}
      </MemorySection>
    </main>
  );
}

function MemorySection({
  title,
  eyebrow,
  children,
}: {
  title: string;
  eyebrow: string;
  children: React.ReactNode;
}) {
  return (
    <section className="memory-section">
      <p className="eyebrow">{eyebrow}</p>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function PreferenceList({ items, empty }: { items: MemoryPreference[]; empty: string }) {
  if (items.length === 0) return <p className="memory-note">{empty}</p>;
  return (
    <ul className="memory-list">
      {items.map((item) => (
        <li key={item.label}>
          <strong>{item.label}</strong>
          <span>
            {item.evidence} of {item.of}
          </span>
        </li>
      ))}
    </ul>
  );
}

function TopicList({ label, items }: { label: string; items: TopicCount[] }) {
  return (
    <div className="memory-topics">
      <h3>{label}</h3>
      {items.length ? (
        <ul className="memory-list">
          {items.slice(0, 8).map((item) => (
            <li key={item.topic}>
              <strong>{item.topic}</strong>
              <span>{item.count}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="memory-note">None yet.</p>
      )}
    </div>
  );
}

function Metric({ value, label }: { value: number; label: string }) {
  return (
    <div className="metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}
