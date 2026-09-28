"use client";

import { ProfileError } from "../../components/profile/ProfileError.tsx";

export default function InsightsError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <ProfileError kind="Insights" what="the insights" reset={reset} />;
}
