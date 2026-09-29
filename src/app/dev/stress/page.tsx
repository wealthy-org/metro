import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { StressScene } from "../../../components/dev/StressScene.tsx";

// Development-only performance check (PROJECT.md 24.6, AT 29; Phase 13 D2): 5,000 synthetic instances, clearly
// labeled as test data. Production answers 404.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Stress check, Metro" };

export default function StressPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <main className="grid h-screen grid-rows-[64px_1fr] bg-bg">
      <div className="flex items-center justify-between border-b border-line bg-panel px-4">
        <div>
          <h1 className="font-display text-[20px] font-bold">Stress check</h1>
          <p className="text-[11px] text-mute">
            5,000 instanced boxes, synthetic test data only. The target is 60 fps on a mid-range laptop (PROJECT.md 19, AT 29). Development-only page; production answers 404.
          </p>
        </div>
        <a href="/lens/city" className="rounded-[3px] border border-line bg-panel2 px-[11px] py-[7px] text-[12px] hover:border-mute">
          Back to the city
        </a>
      </div>
      <StressScene />
    </main>
  );
}
