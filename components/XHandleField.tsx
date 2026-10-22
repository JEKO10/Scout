"use client";

import Image from "next/image";
import { useId, useRef, useState } from "react";

import { lookupXHandleAction, type XHandleLookup } from "@/actions/x";
import type { NormalizedProfile } from "@/lib/x/types";

const LOOKUP_DELAY_MS = 450;
const HANDLE_PATTERN = /^[A-Za-z0-9_]{1,15}$/;

type LookupState = { status: "idle" } | { status: "loading" } | XHandleLookup;

function cleanHandle(value: string) {
  return value.trim().replace(/^@+/, "");
}

export function XHandleField({
  name,
  label,
  hint,
  placeholder,
  defaultValue,
}: {
  name: string;
  label: string;
  hint: string;
  placeholder: string;
  defaultValue: string;
}) {
  const inputId = useId();
  const listboxId = useId();
  const [value, setValue] = useState(defaultValue);
  const [lookup, setLookup] = useState<LookupState>({ status: "idle" });
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<NormalizedProfile | null>(null);

  // Lookups are billed by X, so remember every answer for this page
  const cache = useRef(new Map<string, XHandleLookup>());
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const latestHandle = useRef("");

  function handleChange(nextValue: string) {
    setValue(nextValue);
    setSelected(null);
    clearTimeout(timer.current);

    const handle = cleanHandle(nextValue).toLowerCase();
    latestHandle.current = handle;

    if (!HANDLE_PATTERN.test(handle)) {
      setLookup({ status: "idle" });
      setOpen(false);
      return;
    }

    setOpen(true);
    const cached = cache.current.get(handle);
    if (cached) {
      setLookup(cached);
      return;
    }

    setLookup({ status: "loading" });
    timer.current = setTimeout(async () => {
      const result = await lookupXHandleAction(handle);
      if (result.status !== "error") cache.current.set(handle, result);
      // Ignore answers for a handle the user has already typed past
      if (latestHandle.current === handle) setLookup(result);
    }, LOOKUP_DELAY_MS);
  }

  function select(profile: NormalizedProfile) {
    setValue(profile.handle);
    setSelected(profile);
    setOpen(false);
  }

  const found = lookup.status === "found" ? lookup.profile : null;
  const expanded = open && lookup.status !== "idle";

  return (
    <div className="field-row">
      <label className="field-label" htmlFor={inputId}>
        <strong>
          {label}
          <span className="required-mark" aria-hidden="true">
            *
          </span>
        </strong>
        <small>{hint}</small>
      </label>

      <div className="x-handle-field">
        <div className="x-handle-input">
          <span aria-hidden="true">@</span>
          <input
            id={inputId}
            name={name}
            value={value}
            placeholder={placeholder}
            required
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            role="combobox"
            aria-expanded={expanded}
            aria-controls={listboxId}
            aria-autocomplete="list"
            className="field-control"
            onChange={(event) => handleChange(event.target.value)}
            onFocus={() => setOpen(true)}
            onBlur={() => setOpen(false)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setOpen(false);
              if (event.key === "Enter" && expanded && found) {
                event.preventDefault();
                select(found);
              }
            }}
          />
        </div>

        {expanded && (
          <div className="x-handle-menu" id={listboxId} role="listbox">
            {lookup.status === "loading" && (
              <p className="x-handle-note">
                <span className="x-sync-spinner" aria-hidden="true" />
                Looking up @{cleanHandle(value)} on X…
              </p>
            )}
            {found && (
              <button
                type="button"
                role="option"
                aria-selected="false"
                className="x-handle-option"
                // Keep focus in the input so blur doesn't close the menu first
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => select(found)}
              >
                <XProfileSummary profile={found} />
                <span className="x-handle-hint">Select</span>
              </button>
            )}
            {lookup.status === "not_found" && (
              <p className="x-handle-note">
                No X account named @{cleanHandle(value)}.
              </p>
            )}
            {lookup.status === "error" && (
              <p className="x-handle-note" data-status="error">
                {lookup.message}
              </p>
            )}
          </div>
        )}

        {selected && !expanded && (
          <div className="x-handle-selected" aria-live="polite">
            <XProfileSummary profile={selected} />
            <span className="x-handle-check" aria-label="Selected">
              ✓
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function XProfileSummary({ profile }: { profile: NormalizedProfile }) {
  return (
    <span className="x-handle-profile">
      {profile.avatarUrl ? (
        <Image
          src={profile.avatarUrl}
          alt=""
          width={36}
          height={36}
          className="x-account-avatar"
        />
      ) : (
        <span className="avatar-placeholder" aria-hidden="true">
          {profile.handle.charAt(0).toUpperCase()}
        </span>
      )}
      <span>
        <strong>{profile.displayName ?? profile.handle}</strong>
        <small>@{profile.handle}</small>
      </span>
    </span>
  );
}
