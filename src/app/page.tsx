import type { Metadata } from "next";
import { Landing } from "../components/landing/Landing.tsx";

// Root page: the landing (audit A17, KL-21). The workspace lives at /lens/[name].
export const metadata: Metadata = {
  title: "Metro, Robinhood Chain as a city",
  description: "Metro shows every transaction on Robinhood Chain as buildings, roads and terrain you can click, and explains what changed with the numbers attached.",
};

export default function Home() {
  return <Landing />;
}
