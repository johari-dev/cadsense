import { normalizeCustomModelSlug } from "@cadsense/shared/model";
import { XIcon } from "~/lib/icons";
import { useState } from "react";

import { MAX_CUSTOM_MODEL_COUNT, MAX_CUSTOM_MODEL_LENGTH } from "../../modelSelection";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";

/** Why a typed name was not added, or `undefined` when it can be. */
function rejectCustomModel(
  slug: string,
  models: ReadonlyArray<string>,
  listedModels: ReadonlySet<string>,
): string | undefined {
  if (slug.length > MAX_CUSTOM_MODEL_LENGTH) return "That name is too long.";
  if (models.includes(slug) || listedModels.has(slug)) return "Already in the picker.";
  if (models.length >= MAX_CUSTOM_MODEL_COUNT) {
    return `Up to ${MAX_CUSTOM_MODEL_COUNT} custom models.`;
  }
  return undefined;
}

/**
 * Edits one provider's custom models: names added to its model picker for a
 * gateway that serves models it does not list. Each add or remove is saved
 * through `onChange` right away, like the provider switches. Render it only
 * while it should be open.
 */
export function ProviderCustomModelsDialog({
  label,
  models,
  listedModels,
  onChange,
  onClose,
}: {
  readonly label: string;
  readonly models: ReadonlyArray<string>;
  /** Models and aliases the provider already reports, which need no custom entry. */
  readonly listedModels: ReadonlySet<string>;
  readonly onChange: (models: ReadonlyArray<string>) => void;
  readonly onClose: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | undefined>();

  const add = () => {
    const slug = normalizeCustomModelSlug(draft);
    if (!slug) return;
    const rejection = rejectCustomModel(slug, models, listedModels);
    setError(rejection);
    if (rejection) return;
    onChange([...models, slug]);
    setDraft("");
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{label} custom models</DialogTitle>
          <DialogDescription>
            Added to {label}'s model picker. Use names your gateway accepts but doesn't list.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          {models.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5" aria-label={`${label} custom models`}>
              {models.map((slug) => (
                <li
                  key={slug}
                  className="inline-flex max-w-full items-center gap-1 rounded-md border bg-accent py-0.5 ps-2 pe-0.5 font-mono text-xs"
                >
                  <span className="truncate">{slug}</span>
                  <Button
                    type="button"
                    variant="ghost-muted"
                    size="icon-xs"
                    aria-label={`Remove ${slug}`}
                    onClick={() => onChange(models.filter((model) => model !== slug))}
                  >
                    <XIcon className="size-3" />
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No custom models yet.</p>
          )}
          <div className="flex gap-2">
            <Input
              aria-label="Model name"
              placeholder="Model name, e.g. qwen3-coder:30b"
              className="font-mono"
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                setError(undefined);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  add();
                }
              }}
            />
            <Button
              type="button"
              variant="outline"
              disabled={!normalizeCustomModelSlug(draft)}
              onClick={add}
            >
              Add
            </Button>
          </div>
          {error ? (
            <p role="alert" className="text-xs text-destructive-foreground">
              {error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Done</DialogClose>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
