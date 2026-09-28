"use client";

import { A, ProfileShell } from "./Profile.tsx";

// Error state of the profile pages (antislop R-27, gate F36): the database or the chain could not be read. The page
// says what failed in plain words and offers a retry, instead of the framework's generic 500.
export function ProfileError({ kind, reset }: { kind: string; reset: () => void }) {
  return (
    <ProfileShell kind={kind}>
      <h1 className="font-display text-[34px] leading-none font-bold">Could not load this {kind.toLowerCase()}</h1>
      <p className="mt-3 max-w-[60ch] text-[15px] text-mute">Metro could not read its database or the chain just now. Nothing on the page is guessed, so it shows nothing until the read works again.</p>
      <div className="mt-4 flex items-center gap-4 text-[14px]">
        <button type="button" onClick={reset} className="rounded-[3px] border border-line bg-panel2 px-[11px] py-[7px] text-[12px] text-text hover:border-mute">
          Try again
        </button>
        <A href="/lens/flow">Open the live Flow</A>
      </div>
    </ProfileShell>
  );
}
