import { NotFound } from "../../../components/profile/Profile.tsx";

export default function WalletNotFound() {
  return <NotFound kind="Wallet" text="This is not a valid address. A wallet address is 0x followed by 40 hex characters." />;
}
