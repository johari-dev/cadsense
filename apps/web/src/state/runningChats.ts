import { isDesktopLocalConnectionTarget } from "../connection/desktopLocal";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readThreadShells } from "./entities";
import { environmentPresentations } from "./presentation";

/**
 * How many chats are still working on a backend this app runs: the primary backend or a
 * desktop-managed local one such as WSL. A chat is working while a turn runs, or while
 * background agents or monitors it started are alive. Restarting the app to update stops them.
 */
export function readRunningDesktopChatCount(): number {
  const presentations = appAtomRegistry.get(environmentPresentations.presentationsAtom);
  return readThreadShells().filter((thread) => {
    const turnRunning = thread.session?.status === "running" && thread.session.activeTurnId != null;
    if (!turnRunning && thread.backgroundLiveness == null) return false;
    const target = presentations.get(thread.environmentId)?.entry.target;
    return (
      target !== undefined &&
      (target._tag === "PrimaryConnectionTarget" || isDesktopLocalConnectionTarget(target))
    );
  }).length;
}
