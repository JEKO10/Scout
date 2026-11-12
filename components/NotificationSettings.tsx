"use client";

import { useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";

import {
  chooseSlackChannelAction,
  disconnectSlackAction,
  listSlackChannelsAction,
  saveNotificationSettingsAction,
  sendTestNotificationAction,
} from "@/actions/notifications";

const oauthMessages: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: "Slack connected. Now choose the channel for your alerts." },
  cancelled: { ok: false, text: "Slack connection cancelled." },
  invalid_state: { ok: false, text: "That Slack link expired or wasn't yours. Try connecting again." },
  missing_scope: { ok: false, text: "Slack didn't grant every permission Scout needs. Try again." },
  failed: { ok: false, text: "Slack connection failed. Try again." },
  not_configured: { ok: false, text: "Slack isn't set up on this Scout server yet." },
};

const connectionNotes: Record<string, string> = {
  needs_reconnect: "Scout lost access to this workspace. Connect Slack again.",
  channel_unavailable: "Scout can't post to that channel anymore. Choose another one.",
};

const deliveryReasons: Record<string, string> = {
  quiet_hours: "quiet hours",
  daily_limit: "daily limit reached",
  disabled: "alerts were off",
  not_connected: "Slack wasn't connected",
  already_handled: "you'd already handled it",
  stale: "too late to be useful",
};

const hours = Array.from({ length: 24 }, (_, hour) => hour);
const hourLabel = (hour: number) => `${String(hour).padStart(2, "0")}:00`;

export type NotificationSettingsData = {
  slackConfigured: boolean;
  connection: {
    teamName: string;
    channelName: string | null;
    status: "active" | "needs_reconnect" | "channel_unavailable";
  } | null;
  settings: {
    slackEnabled: boolean;
    minScore: number;
    maxPerDay: number;
    quietHoursStart: number | null;
    quietHoursEnd: number | null;
    timezone: string;
  };
  sentToday: number;
  /** Formatted on the server */
  lastDelivery: { status: string; reason: string | null; timeLabel: string } | null;
};

export function NotificationSettings({ data }: { data: NotificationSettingsData }) {
  const params = useSearchParams();
  const oauth = oauthMessages[params.get("slack") ?? ""];
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(oauth ?? null);
  const [pending, startTransition] = useTransition();

  const [form, setForm] = useState(data.settings);
  const [quiet, setQuiet] = useState(data.settings.quietHoursStart !== null);
  const [channels, setChannels] = useState<{ id: string; name: string }[] | null>(null);
  const [channelId, setChannelId] = useState("");
  const [timezones, setTimezones] = useState<string[]>([data.settings.timezone]);

  // Browser-only values, read on interaction so server and client HTML match
  function loadTimezones() {
    if (timezones.length < 2) setTimezones(Intl.supportedValuesOf("timeZone"));
  }

  function pickDeviceTimezone() {
    loadTimezones();
    setForm({ ...form, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" });
  }

  const connection = data.connection;
  const channelReady = connection?.status === "active" && Boolean(connection.channelName);

  function run(action: () => Promise<{ ok: boolean; message: string }>) {
    setMessage(null);
    startTransition(async () => {
      const result = await action();
      setMessage({ ok: result.ok, text: result.message });
    });
  }

  function loadChannels() {
    setMessage(null);
    startTransition(async () => {
      const result = await listSlackChannelsAction();
      if (result.ok) {
        setChannels(result.channels);
        setChannelId(result.channels[0]?.id ?? "");
      } else {
        setMessage({ ok: false, text: result.message });
      }
    });
  }

  function save() {
    run(() =>
      saveNotificationSettingsAction({
        ...form,
        quietHoursStart: quiet ? (form.quietHoursStart ?? 22) : null,
        quietHoursEnd: quiet ? (form.quietHoursEnd ?? 7) : null,
      }),
    );
  }

  return (
    <section className="profile-form">
      <div className="form-intro">
        <p className="eyebrow">Notifications</p>
        <h2>Alerts in Slack</h2>
        <p>
          When an automatic scan finds a strong, fresh opportunity, Scout posts it to your Slack.
          Alerts show the post and why Scout picked it, never your Brain or profile.
        </p>
      </div>

      <div>
        <div className="form-fields">
          <div className="field-row">
            <span className="field-label">
              <strong>Slack workspace</strong>
              <small>
                {connection
                  ? (connectionNotes[connection.status] ?? "Connected")
                  : "Scout installs a bot that only posts your alerts."}
              </small>
            </span>
            <div className="notification-inline">
              {connection ? (
                <>
                  <span>{connection.teamName}</span>
                  {connection.status === "needs_reconnect" && (
                    <a className="secondary-button" href="/api/slack/oauth/start">
                      Reconnect
                    </a>
                  )}
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={pending}
                    onClick={() => run(disconnectSlackAction)}
                  >
                    Disconnect
                  </button>
                </>
              ) : data.slackConfigured ? (
                <a className="primary-button" href="/api/slack/oauth/start">
                  Connect Slack
                </a>
              ) : (
                <span className="notification-muted">Slack isn&apos;t set up on this server yet.</span>
              )}
            </div>
          </div>

          {connection && connection.status !== "needs_reconnect" && (
            <div className="field-row">
              <span className="field-label">
                <strong>Channel</strong>
                <small>Public channels; Scout joins the one you pick.</small>
              </span>
              <div className="notification-inline">
                {channels ? (
                  <>
                    <select
                      className="field-control"
                      value={channelId}
                      onChange={(event) => setChannelId(event.target.value)}
                      aria-label="Slack channel"
                    >
                      {channels.map((channel) => (
                        <option key={channel.id} value={channel.id}>
                          #{channel.name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="primary-button"
                      disabled={pending || !channelId}
                      onClick={() =>
                        run(async () => {
                          const result = await chooseSlackChannelAction(channelId);
                          if (result.ok) setChannels(null);
                          return result;
                        })
                      }
                    >
                      Use channel
                    </button>
                  </>
                ) : (
                  <>
                    <span>{connection.channelName ? `#${connection.channelName}` : "No channel yet"}</span>
                    <button type="button" className="secondary-button" disabled={pending} onClick={loadChannels}>
                      {connection.channelName ? "Change" : "Choose channel"}
                    </button>
                  </>
                )}
              </div>
            </div>
          )}

          <div className="field-row">
            <span className="field-label">
              <strong>Slack alerts</strong>
              <small>
                {channelReady
                  ? `Today: ${data.sentToday} of ${form.maxPerDay}`
                  : "Connect Slack and choose a channel first."}
                {data.lastDelivery &&
                  ` · Last: ${data.lastDelivery.status}${
                    data.lastDelivery.reason
                      ? ` (${deliveryReasons[data.lastDelivery.reason] ?? data.lastDelivery.reason})`
                      : ""
                  } ${data.lastDelivery.timeLabel}`}
              </small>
            </span>
            <label className="notification-inline">
              <input
                type="checkbox"
                checked={form.slackEnabled}
                disabled={!channelReady && !form.slackEnabled}
                onChange={(event) => setForm({ ...form, slackEnabled: event.target.checked })}
              />
              <span>Send alerts to Slack</span>
            </label>
          </div>

          {channelReady && (
            <div className="field-row">
              <span className="field-label">
                <strong>Test</strong>
                <small>A labeled test message. Doesn&apos;t scan or count toward today&apos;s alerts.</small>
              </span>
              <div className="notification-inline">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={pending}
                  onClick={() => run(sendTestNotificationAction)}
                >
                  {pending ? "Sending…" : "Send test notification"}
                </button>
              </div>
            </div>
          )}

          <div className="field-row">
            <span className="field-label">
              <strong>Minimum score</strong>
              <small>Only opportunities at least this strong.</small>
            </span>
            <select
              className="field-control"
              value={form.minScore}
              onChange={(event) => setForm({ ...form, minScore: Number(event.target.value) })}
            >
              {[60, 70, 80, 90].map((score) => (
                <option key={score} value={score}>
                  {score}+{score === 80 ? " (recommended)" : ""}
                </option>
              ))}
            </select>
          </div>

          <div className="field-row">
            <span className="field-label">
              <strong>Alerts per day</strong>
              <small>The freshest opportunities get the slots.</small>
            </span>
            <select
              className="field-control"
              value={form.maxPerDay}
              onChange={(event) => setForm({ ...form, maxPerDay: Number(event.target.value) })}
            >
              {[1, 3, 5, 10, 20].map((count) => (
                <option key={count} value={count}>
                  {count}
                </option>
              ))}
            </select>
          </div>

          <div className="field-row">
            <span className="field-label">
              <strong>Quiet hours</strong>
              <small>No Slack alerts in this window; they stay in the bell.</small>
            </span>
            <div className="notification-inline">
              <input
                type="checkbox"
                checked={quiet}
                onChange={(event) => setQuiet(event.target.checked)}
                aria-label="Quiet hours"
              />
              <select
                className="field-control"
                disabled={!quiet}
                value={form.quietHoursStart ?? 22}
                onChange={(event) => setForm({ ...form, quietHoursStart: Number(event.target.value) })}
                aria-label="Quiet hours start"
              >
                {hours.map((hour) => (
                  <option key={hour} value={hour}>
                    {hourLabel(hour)}
                  </option>
                ))}
              </select>
              <span>to</span>
              <select
                className="field-control"
                disabled={!quiet}
                value={form.quietHoursEnd ?? 7}
                onChange={(event) => setForm({ ...form, quietHoursEnd: Number(event.target.value) })}
                aria-label="Quiet hours end"
              >
                {hours.map((hour) => (
                  <option key={hour} value={hour}>
                    {hourLabel(hour)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="field-row">
            <span className="field-label">
              <strong>Timezone</strong>
              <small>For quiet hours and when the daily limit resets.</small>
            </span>
            <div className="notification-inline">
              <select
                className="field-control"
                value={form.timezone}
                onFocus={loadTimezones}
                onPointerDown={loadTimezones}
                onChange={(event) => setForm({ ...form, timezone: event.target.value })}
                aria-label="Timezone"
              >
                {(timezones.includes(form.timezone) ? timezones : [form.timezone, ...timezones]).map((zone) => (
                  <option key={zone} value={zone}>
                    {zone}
                  </option>
                ))}
              </select>
              <button type="button" className="secondary-button" onClick={pickDeviceTimezone}>
                Use this device&apos;s
              </button>
            </div>
          </div>
        </div>

        <div className="form-footer">
          <div aria-live="polite">
            {message && (
              <p className="form-message" data-status={message.ok ? "success" : "error"}>
                {message.text}
              </p>
            )}
          </div>
          <button type="button" className="primary-button" disabled={pending} onClick={save}>
            Save notifications
          </button>
        </div>
      </div>
    </section>
  );
}
