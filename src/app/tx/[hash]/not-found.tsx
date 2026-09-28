import { NotFound } from "../../../components/profile/Profile.tsx";

export default function TxNotFound() {
  return <NotFound kind="Transaction" text="No transaction with this hash is in Metro's ingested blocks or on the chain. Check that the hash is complete: 0x followed by 64 hex characters." />;
}
