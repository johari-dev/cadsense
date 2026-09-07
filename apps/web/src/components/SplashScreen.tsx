import { LoadingMark } from "./LoadingMark";

export function SplashScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="flex size-24 items-center justify-center" aria-label="cadsense splash screen">
        <LoadingMark kind="app" />
      </div>
    </div>
  );
}
