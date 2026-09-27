import { Ticker } from "../components/layout/Ticker.tsx";

export default function Home() {
  return (
    <>
      <div role="alert" className="fixed inset-0 z-50 hidden items-center justify-center bg-bg p-8 text-center max-[1279px]:flex">
        <div>
          <h1 className="mb-2 font-display text-[34px] font-bold">Open Metro on a wider screen</h1>
          <p className="mx-auto max-w-[36ch] text-mute">Metro is built for laptop and desktop displays, at least 1280 px wide. Widen this window to continue.</p>
        </div>
      </div>
      <div className="flex h-screen flex-col max-[1279px]:hidden">
        <Ticker />
        <main className="flex flex-1 items-center justify-center">
          <p className="max-w-[48ch] text-center text-mute">
            The city view is not built yet. The readout above is live Robinhood Chain data from the Collector.
          </p>
        </main>
      </div>
    </>
  );
}
