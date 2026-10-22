import type { ResolvedScoutBrain } from "@/services/scout-brain/resolveBrain";

import { AnalyzeBrainButton } from "./AnalyzeBrainButton";
import { BrainList } from "./BrainList";

const dateFormat = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const perspectiveLabels = {
  personal: "A person (“I”)",
  institutional: "An organization (“we”)",
  mixed: "Both “I” and “we”",
} as const;

const humanize = (value: string) =>
  value.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());

export function ScoutBrainPanel({
  brain,
  postCount,
}: {
  brain: ResolvedScoutBrain | null;
  postCount: number;
}) {
  return (
    <section className="brain-section" aria-labelledby="brain-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">What Scout learned</p>
          <h2 id="brain-title">Your Scout Brain</h2>
          <p className="brain-meta">
            {brain
              ? `Based on ${brain.postCount} posts · Analyzed ${dateFormat.format(brain.analyzedAt)}. Remove anything that's wrong; your edits survive re-analysis.`
              : postCount
                ? `Scout will read your ${postCount} imported posts and your onboarding answers.`
                : "Sync your X account first so Scout has posts to learn from."}
          </p>
        </div>
        <AnalyzeBrainButton analyzed={Boolean(brain)} />
      </div>

      {brain && (
        <div className="brain-grid">
          <article className="brain-column">
            <p className="eyebrow">Voice</p>
            <p className="brain-summary">{brain.voice.summary}</p>

            <BrainGroup label="Tone">
              <BrainList brain="voice" list="tone" items={brain.voice.tone} addLabel="Add a tone" />
            </BrainGroup>

            <dl className="brain-facts">
              <Fact label="Speaks as" value={perspectiveLabels[brain.voice.perspective]} />
              <Fact label="Sentences" value={humanize(brain.voice.sentenceLength)} />
              <Fact label="Directness" value={humanize(brain.voice.directness)} />
              <Fact label="Emoji" value={humanize(brain.voice.emojiUsage)} />
              <Fact label="Capitalization" value={humanize(brain.voice.capitalization)} />
              <Fact label="Languages" value={brain.voice.languages.join(", ")} />
              <Fact label="Humor" value={brain.voice.humor} />
            </dl>

            <BrainGroup label="Signature phrases">
              <BrainList
                brain="voice"
                list="signaturePhrases"
                items={brain.voice.signaturePhrases}
                addLabel="Add a phrase you use"
                emptyLabel="No recurring phrases found."
              />
            </BrainGroup>

            <BrainGroup label="Never">
              <BrainList brain="voice" list="avoid" items={brain.voice.avoid} addLabel="Add something to avoid" />
            </BrainGroup>

            {brain.voice.promotionalPatterns.length > 0 && (
              <BrainGroup label="Promotional patterns — kept out of replies">
                <p className="brain-muted">
                  {brain.voice.promotionalPatterns
                    .map((pattern) => `“${pattern}”`)
                    .join(", ")}
                </p>
              </BrainGroup>
            )}
          </article>

          <article className="brain-column">
            <p className="eyebrow">Interests</p>

            <BrainGroup label="Topics">
              <BrainList brain="interests" list="topics" items={brain.interests.topics} addLabel="Add an interest" />
            </BrainGroup>

            <BrainGroup label="Recurring themes">
              <BrainList
                brain="interests"
                list="recurringThemes"
                items={brain.interests.recurringThemes}
                addLabel="Add a theme"
              />
            </BrainGroup>

            {brain.interests.expertise.length > 0 && (
              <BrainGroup label="Expertise">
                <ul className="brain-notes">
                  {brain.interests.expertise.map((item) => (
                    <li key={item.area} data-evidence={item.evidence}>
                      <strong>{item.area}</strong>
                      <span>{item.reasoning}</span>
                    </li>
                  ))}
                </ul>
              </BrainGroup>
            )}

            {brain.interests.opinions.length > 0 && (
              <BrainGroup label="Opinions">
                <ul className="brain-notes">
                  {brain.interests.opinions.map((opinion) => (
                    <li key={opinion.statement}>
                      <strong>{opinion.topic}</strong>
                      <span>{opinion.statement}</span>
                    </li>
                  ))}
                </ul>
              </BrainGroup>
            )}

            {brain.interests.lowConfidenceTopics.length > 0 && (
              <BrainGroup label="Low confidence — Scout stays away">
                <p className="brain-muted">
                  {brain.interests.lowConfidenceTopics
                    .map((topic) => topic.name)
                    .join(", ")}
                </p>
              </BrainGroup>
            )}
          </article>

          <article className="brain-column">
            <p className="eyebrow">Goal</p>
            <p className="brain-summary">{brain.goals.desiredPositioning}</p>

            <dl className="brain-facts">
              <Fact label="Primary goal" value={brain.goals.primaryGoal} />
              <Fact label="Role" value={brain.goals.occupation} />
            </dl>

            <BrainGroup label="Audience">
              <BrainList
                brain="goals"
                list="targetAudience"
                items={brain.goals.targetAudience}
                addLabel="Add an audience"
              />
            </BrainGroup>

            <BrainGroup label="Known for">
              <BrainList brain="goals" list="knownFor" items={brain.goals.knownFor} addLabel="Add a topic" />
            </BrainGroup>

            <BrainGroup label="How your posts fit this goal">
              <p className="brain-muted">{brain.goals.postingAlignment}</p>
            </BrainGroup>
          </article>
        </div>
      )}
    </section>
  );
}

function BrainGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="brain-group">
      <h3>{label}</h3>
      {children}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
