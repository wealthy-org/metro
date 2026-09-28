"use client";

import { ProfileError } from "../../components/profile/ProfileError.tsx";

export default function SubsidyError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <ProfileError kind="Subsidy Cliff" what="the Subsidy Cliff figures" reset={reset} />;
}
