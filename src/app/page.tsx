import { LensRail } from "../components/layout/LensRail.tsx";
import { Ticker } from "../components/layout/Ticker.tsx";
import { Workspace } from "../components/layout/Workspace.tsx";

// App grid from project-4-metro-prototype.html: Ticker across the top, lens rail, stage, 388 px side panel.
export default function Home() {
  return (
    <>
      <div role="alert" className="fixed inset-0 z-50 hidden items-center justify-center bg-bg p-8 text-center max-[1279px]:flex">
        <div>
          <h1 className="mb-2 font-display text-[34px] font-bold">Open Metro on a wider screen</h1>
          <p className="mx-auto max-w-[36ch] text-mute">Metro is built for laptop and desktop displays, at least 1280 px wide. Widen this window to continue.</p>
        </div>
      </div>
      <div className="grid h-screen grid-cols-[64px_1fr_388px] grid-rows-[56px_1fr] overflow-hidden max-[1279px]:hidden">
        <div className="col-span-3">
          <Ticker />
        </div>
        <LensRail active="city" />
        <Workspace />
      </div>
    </>
  );
}
