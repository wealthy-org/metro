"use client";

import { ProfileError } from "../../../components/profile/ProfileError.tsx";

export default function TxError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <ProfileError kind="Transaction" reset={reset} />;
}
