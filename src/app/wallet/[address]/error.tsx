"use client";

import { ProfileError } from "../../../components/profile/ProfileError.tsx";

export default function WalletError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <ProfileError kind="Wallet" reset={reset} />;
}
