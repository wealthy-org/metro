"use client";

import { ProfileError } from "../../../components/profile/ProfileError.tsx";

export default function TokenError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <ProfileError kind="Token" reset={reset} />;
}
