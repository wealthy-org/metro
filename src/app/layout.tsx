import type { Metadata } from "next";
import { Big_Shoulders, JetBrains_Mono, Public_Sans } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";

// Google Fonts renamed "Big Shoulders Display" to Big Shoulders with an optical-size axis; the new name is used (KL-18).
// Next.js has no fallback metrics for it, so the size-adjusted fallback is off and Arial Narrow is used while it loads.
const display = Big_Shoulders({
  subsets: ["latin"],
  axes: ["opsz"],
  variable: "--font-big-shoulders",
  adjustFontFallback: false,
  fallback: ["Arial Narrow", "sans-serif"],
});
const sans = Public_Sans({ subsets: ["latin"], variable: "--font-public-sans" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains-mono" });

export const metadata: Metadata = {
  title: "Metro, Robinhood Chain as a city",
  description: "Robinhood Chain activity as a city you can click, with the numbers behind every building.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${sans.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
