import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { LensRail, RAIL_LENSES } from "../../../components/layout/LensRail.tsx";
import { NarrowGuard } from "../../../components/layout/NarrowGuard.tsx";
import { Ticker } from "../../../components/layout/Ticker.tsx";
import { Workspace } from "../../../components/layout/Workspace.tsx";

// Workspace route (PROJECT.md 7 `/lens/[name]`; KL-21): the app grid from project-4-metro-prototype.html, with the
// Ticker across the top, lens rail, stage and a 388 px side panel.

type Params = { params: Promise<{ name: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { name } = await params;
  const lens = RAIL_LENSES.find((l) => l.key === name);
  return { title: lens ? `${lens.label} lens, Metro` : "Metro" };
}

export default async function LensPage({ params }: Params) {
  const { name } = await params;
  if (!RAIL_LENSES.some((l) => l.key === name)) notFound();
  return (
    <>
      <NarrowGuard />
      <div className="grid h-screen grid-cols-[64px_1fr_388px] grid-rows-[56px_1fr] overflow-hidden max-[1279px]:hidden">
        <div className="col-span-3">
          <Ticker />
        </div>
        {/* useSearchParams needs a Suspense boundary; the fallback keeps the grid while the query is read. */}
        <Suspense
          fallback={
            <>
              <LensRail active={name} query="" />
              <main className="bg-bg" />
              <aside className="border-l border-line bg-panel" />
            </>
          }
        >
          <Workspace lens={name} />
        </Suspense>
      </div>
    </>
  );
}
