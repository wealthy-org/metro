// Below 1280 px the workspace is replaced by this message instead of a broken layout (PROJECT.md 19, AT 26).
export function NarrowGuard() {
  return (
    <div role="alert" className="fixed inset-0 z-50 hidden items-center justify-center bg-bg p-8 text-center max-[1279px]:flex">
      <div>
        <h1 className="mb-2 font-display text-[34px] font-bold">Open Metro on a wider screen</h1>
        <p className="mx-auto max-w-[36ch] text-mute">Metro is built for laptop and desktop displays, at least 1280 px wide. Widen this window to continue.</p>
      </div>
    </div>
  );
}
