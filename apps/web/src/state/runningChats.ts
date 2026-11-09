import { isDesktopLocalConnectionTarget } from "../connection/desktopLocal";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readThreadShells } from "./entities";
import { environmentPresentations } from "./presentation";

/**
 * How many chats have a turn in progress on a backend this app runs: the primary backend or a
 * desktop-managed local one such as WSL. Restarting the app to install an update stops them.
 */
export function readRunningDesktopChatCount(): number {
  const presentations = appAtomRegistry.get(environmentPresentations.presentationsAtom);
  return readThreadShells().filter((thread) => {
    if (thread.session?.status !== "running" || thread.session.activeTurnId == null) return false;
    const target = presentations.get(thread.environmentId)?.entry.target;
    return (
      target !== undefined &&
      (target._tag === "PrimaryConnectionTarget" || isDesktopLocalConnectionTarget(target))
    );
  }).length;
}
