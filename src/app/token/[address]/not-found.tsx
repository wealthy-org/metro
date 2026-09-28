import { NotFound } from "../../../components/profile/Profile.tsx";

export default function TokenNotFound() {
  return <NotFound kind="Token" text="This address is not a token Metro knows, and it does not answer as an ERC-20 contract on the chain. Check that the address is complete: 0x followed by 40 hex characters." />;
}
