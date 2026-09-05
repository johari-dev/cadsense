import { resolveOnshapeSettingsEnvironment } from "../../lib/onshapeSettingsEnvironment";
import {
  connectionStatusText,
  type EnvironmentPresentation as BaseEnvironmentPresentation,
} from "@cadsense/client-runtime/connection";
import {
  MAX_ONSHAPE_ACCESS_KEY_ID_LENGTH,
  MAX_ONSHAPE_CONNECTION_HOST_LENGTH,
  MAX_ONSHAPE_CONNECTION_NAME_LENGTH,
  MAX_ONSHAPE_SECRET_KEY_LENGTH,
  type EnvironmentId,
  type OnshapeConnectionSummary,
} from "@cadsense/contracts";
import {
  CheckCircle2Icon,
  KeyRoundIcon,
  LaptopIcon,
  LinkIcon,
  MonitorIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { cn } from "../../lib/utils";
import {
  useEnvironments,
  usePrimaryEnvironmentId,
  type EnvironmentPresentation,
} from "../../state/environments";
import {
  ConnectionStatusDot,
  connectionPhaseDotClassName,
  connectionPhasePingClassName,
} from "../ConnectionStatusDot";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { Field, FieldDescription, FieldLabel } from "../ui/field";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  DEFAULT_ONSHAPE_HOST,
  onshapeHostsDiffer,
  type OnshapeConnectionDraft,
  type OnshapeConnectionDraftErrors,
  type OnshapeConnectionDraftField,
  type OnshapeCredentialDraft,
  resolveOnshapeEnvironmentSelection,
  validateOnshapeConnectionDraft,
  validateOnshapeConnectionName,
  validateOnshapeCredentialDraft,
} from "./OnshapeConnectionsSettings.logic";
import { OnshapeFieldError } from "./OnshapeFieldError";
import { searchableSetting } from "./settingsSearch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { providerSettingsTabClassName } from "./providerSettingsTabs";
import {
  type OnshapeConnectionEditor,
  useOnshapeConnectionPendingKey,
  useOnshapeConnectionsController,
} from "./useOnshapeConnectionsController";
import { useOnshapeConnectionsFocus } from "./useOnshapeConnectionsFocus";

const onshapeSearchMetadata = searchableSetting("onshape-connections");
const verifiedAtFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
const ADD_CONNECTION_FIELD_ORDER = ["name", "host", "accessKeyId", "secretKey"] as const;
const CREDENTIAL_FIELD_ORDER = ["host", "accessKeyId", "secretKey"] as const;

interface ErrorFocusRequest {
  readonly field: OnshapeConnectionDraftField;
  readonly sequence: number;
}

function nextErrorFocusRequest(
  current: ErrorFocusRequest | null,
  field: OnshapeConnectionDraftField,
): ErrorFocusRequest {
  return { field, sequence: (current?.sequence ?? 0) + 1 };
}

function firstDraftError(
  errors: OnshapeConnectionDraftErrors,
  order: ReadonlyArray<OnshapeConnectionDraftField>,
): OnshapeConnectionDraftField | undefined {
  return order.find((field) => errors[field] !== undefined);
}

function clearFieldError(
  errors: OnshapeConnectionDraftErrors,
  field: OnshapeConnectionDraftField,
): OnshapeConnectionDraftErrors {
  const next = { ...errors };
  delete next[field];
  return next;
}

function VerifiedAt({ value }: { readonly value: string }) {
  const date = new Date(value);
  const label = Number.isNaN(date.getTime())
    ? "Verified"
    : `Verified ${verifiedAtFormatter.format(date)}`;

  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <CheckCircle2Icon className="size-3.5 text-success" aria-hidden />
      <time dateTime={value}>{label}</time>
    </span>
  );
}

function FormActions({
  pending,
  pendingLabel,
  submitLabel,
  onCancel,
}: {
  readonly pending: boolean;
  readonly pendingLabel: string;
  readonly submitLabel: string;
  readonly onCancel: () => void;
}) {
  return (
    <div className="flex flex-wrap justify-end gap-2 pt-1">
      <Button type="button" variant="ghost-muted" disabled={pending} onClick={onCancel}>
        Cancel
      </Button>
      <Button type="submit" disabled={pending} aria-disabled={pending}>
        {pending ? <Spinner className="size-3.5" aria-hidden /> : null}
        {pending ? pendingLabel : submitLabel}
      </Button>
    </div>
  );
}

function TextField({
  id,
  label,
  value,
  error,
  disabled,
  description,
  placeholder,
  type = "text",
  autoComplete,
  maxLength,
  autoFocus = false,
  errorFocusRequest = null,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly error: string | undefined;
  readonly disabled: boolean;
  readonly description?: ReactNode;
  readonly placeholder?: string;
  readonly type?: "text" | "password";
  readonly autoComplete?: string;
  readonly maxLength?: number;
  readonly autoFocus?: boolean;
  readonly errorFocusRequest?: number | null;
  readonly onChange: (value: string) => void;
}) {
  const errorId = `${id}-error`;
  const descriptionId = `${id}-description`;
  const describedBy = [description ? descriptionId : null, error ? errorId : null]
    .filter((value): value is string => value !== null)
    .join(" ");
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        nativeInput
        type={type}
        value={value}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        autoComplete={autoComplete}
        maxLength={maxLength}
        autoFocus={autoFocus}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      {description ? <FieldDescription id={descriptionId}>{description}</FieldDescription> : null}
      {error ? (
        <OnshapeFieldError id={errorId} inputId={id} focusRequest={errorFocusRequest}>
          {error}
        </OnshapeFieldError>
      ) : null}
    </Field>
  );
}

function CredentialFields({
  idPrefix,
  draft,
  errors,
  errorFocus,
  disabled,
  autoFocusHost = false,
  onChange,
}: {
  readonly idPrefix: string;
  readonly draft: OnshapeCredentialDraft;
  readonly errors: OnshapeConnectionDraftErrors;
  readonly errorFocus: ErrorFocusRequest | null;
  readonly disabled: boolean;
  readonly autoFocusHost?: boolean;
  readonly onChange: (field: keyof OnshapeCredentialDraft, value: string) => void;
}) {
  return (
    <>
      <TextField
        id={`${idPrefix}-host`}
        label="Stack host"
        value={draft.host}
        error={errors.host}
        errorFocusRequest={errorFocus?.field === "host" ? errorFocus.sequence : null}
        disabled={disabled}
        autoFocus={autoFocusHost}
        placeholder={DEFAULT_ONSHAPE_HOST}
        autoComplete="url"
        maxLength={MAX_ONSHAPE_CONNECTION_HOST_LENGTH}
        description="Use cad.onshape.com unless your organization has a different Onshape stack."
        onChange={(value) => onChange("host", value)}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          id={`${idPrefix}-access-key-id`}
          label="Access key ID"
          value={draft.accessKeyId}
          error={errors.accessKeyId}
          errorFocusRequest={errorFocus?.field === "accessKeyId" ? errorFocus.sequence : null}
          disabled={disabled}
          autoComplete="off"
          maxLength={MAX_ONSHAPE_ACCESS_KEY_ID_LENGTH}
          onChange={(value) => onChange("accessKeyId", value)}
        />
        <TextField
          id={`${idPrefix}-secret-key`}
          label="Secret key"
          value={draft.secretKey}
          error={errors.secretKey}
          errorFocusRequest={errorFocus?.field === "secretKey" ? errorFocus.sequence : null}
          disabled={disabled}
          type="password"
          autoComplete="off"
          maxLength={MAX_ONSHAPE_SECRET_KEY_LENGTH}
          description="Write-only. cadsense will never show this value again."
          onChange={(value) => onChange("secretKey", value)}
        />
      </div>
    </>
  );
}

export function AddConnectionForm({
  formId,
  pending,
  onCancel,
  onSave,
}: {
  readonly formId: string;
  readonly pending: boolean;
  readonly onCancel: () => void;
  readonly onSave: (draft: OnshapeConnectionDraft) => Promise<string | null>;
}) {
  const idPrefix = useId();
  const [draft, setDraft] = useState<OnshapeConnectionDraft>({
    name: "",
    host: DEFAULT_ONSHAPE_HOST,
    accessKeyId: "",
    secretKey: "",
  });
  const [errors, setErrors] = useState<OnshapeConnectionDraftErrors>({});
  const [errorFocus, setErrorFocus] = useState<ErrorFocusRequest | null>(null);

  const update = (field: OnshapeConnectionDraftField, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
    setErrors((current) => clearFieldError(current, field));
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    const validation = validateOnshapeConnectionDraft(draft);
    if (!validation.ok) {
      setErrors(validation.errors);
      const field = firstDraftError(validation.errors, ADD_CONNECTION_FIELD_ORDER);
      if (field !== undefined) {
        setErrorFocus((current) => nextErrorFocusRequest(current, field));
      }
      return;
    }
    void onSave(validation.value);
  };

  return (
    <form
      id={formId}
      className="space-y-4 rounded-2xl border border-border/70 bg-card p-4 shadow-xs/5 sm:p-5"
      onSubmit={submit}
      aria-label="Add Onshape connection"
    >
      <div className="space-y-1">
        <h3 className="text-sm font-semibold text-foreground">Add connection</h3>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Saving verifies these credentials with Onshape and uses an API request.
        </p>
      </div>
      <TextField
        id={`${idPrefix}-name`}
        label="Name"
        value={draft.name}
        error={errors.name}
        errorFocusRequest={errorFocus?.field === "name" ? errorFocus.sequence : null}
        disabled={pending}
        autoFocus
        placeholder="Team Onshape"
        autoComplete="off"
        maxLength={MAX_ONSHAPE_CONNECTION_NAME_LENGTH}
        onChange={(value) => update("name", value)}
      />
      <CredentialFields
        idPrefix={idPrefix}
        draft={draft}
        errors={errors}
        errorFocus={errorFocus}
        disabled={pending}
        onChange={update}
      />
      <FormActions
        pending={pending}
        pendingLabel="Verifying..."
        submitLabel="Save and verify"
        onCancel={onCancel}
      />
    </form>
  );
}

function RenameConnectionForm({
  formId,
  connection,
  pending,
  onCancel,
  onSave,
}: {
  readonly formId: string;
  readonly connection: OnshapeConnectionSummary;
  readonly pending: boolean;
  readonly onCancel: () => void;
  readonly onSave: (name: string) => Promise<string | null>;
}) {
  const id = useId();
  const [name, setName] = useState(connection.name);
  const [error, setError] = useState<string | undefined>();
  const [errorFocusRequest, setErrorFocusRequest] = useState(0);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    const validation = validateOnshapeConnectionName(name);
    if (!validation.ok) {
      setError(validation.errors.name);
      setErrorFocusRequest((current) => current + 1);
      return;
    }
    void onSave(validation.value.name);
  };

  return (
    <form
      id={formId}
      className="space-y-4 border-t border-border/60 px-4 py-4 sm:px-5"
      onSubmit={submit}
    >
      <div className="space-y-1">
        <h4 className="text-sm font-medium text-foreground">Rename connection</h4>
        <p className="text-xs text-muted-foreground">
          Renaming is local and does not contact Onshape.
        </p>
      </div>
      <TextField
        id={`${id}-name`}
        label="Name"
        value={name}
        error={error}
        errorFocusRequest={error === undefined ? null : errorFocusRequest}
        disabled={pending}
        autoFocus
        autoComplete="off"
        maxLength={MAX_ONSHAPE_CONNECTION_NAME_LENGTH}
        onChange={(value) => {
          setName(value);
          setError(undefined);
        }}
      />
      <FormActions
        pending={pending}
        pendingLabel="Saving..."
        submitLabel="Save name"
        onCancel={onCancel}
      />
    </form>
  );
}

function ReplaceCredentialsForm({
  formId,
  connection,
  pending,
  onCancel,
  onSave,
}: {
  readonly formId: string;
  readonly connection: OnshapeConnectionSummary;
  readonly pending: boolean;
  readonly onCancel: () => void;
  readonly onSave: (draft: OnshapeCredentialDraft) => Promise<string | null>;
}) {
  const idPrefix = useId();
  const [draft, setDraft] = useState<OnshapeCredentialDraft>({
    host: connection.host,
    accessKeyId: "",
    secretKey: "",
  });
  const [errors, setErrors] = useState<OnshapeConnectionDraftErrors>({});
  const [errorFocus, setErrorFocus] = useState<ErrorFocusRequest | null>(null);
  const hostChanged = onshapeHostsDiffer(connection.host, draft.host);

  const update = (field: keyof OnshapeCredentialDraft, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
    setErrors((current) => clearFieldError(current, field));
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    const validation = validateOnshapeCredentialDraft(draft);
    if (!validation.ok) {
      setErrors(validation.errors);
      const field = firstDraftError(validation.errors, CREDENTIAL_FIELD_ORDER);
      if (field !== undefined) {
        setErrorFocus((current) => nextErrorFocusRequest(current, field));
      }
      return;
    }
    void onSave(validation.value);
  };

  return (
    <form
      id={formId}
      className="space-y-4 border-t border-border/60 px-4 py-4 sm:px-5"
      onSubmit={submit}
    >
      <div className="space-y-1">
        <h4 className="text-sm font-medium text-foreground">Replace credentials</h4>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Enter both keys again. Saving verifies the replacement with Onshape and uses an API
          request.
        </p>
      </div>
      <CredentialFields
        idPrefix={idPrefix}
        draft={draft}
        errors={errors}
        errorFocus={errorFocus}
        disabled={pending}
        autoFocusHost
        onChange={update}
      />
      {hostChanged ? (
        <Alert variant="warning">
          <TriangleAlertIcon aria-hidden />
          <AlertTitle>Stack host changed</AlertTitle>
          <AlertDescription>
            Onshape projects that use this connection keep their existing CAD offline, but future
            sync requires a connection for the same stack host.
          </AlertDescription>
        </Alert>
      ) : null}
      <FormActions
        pending={pending}
        pendingLabel="Verifying..."
        submitLabel="Save and verify"
        onCancel={onCancel}
      />
    </form>
  );
}

function ConnectionCard({
  connection,
  editor,
  pendingKey,
  interactionsDisabled,
  onEdit,
  onCancelEdit,
  onRename,
  onReplaceCredentials,
  onRemove,
}: {
  readonly connection: OnshapeConnectionSummary;
  readonly editor: OnshapeConnectionEditor;
  readonly pendingKey: string | null;
  readonly interactionsDisabled: boolean;
  readonly onEdit: (editor: Exclude<OnshapeConnectionEditor, null>) => void;
  readonly onCancelEdit: () => void;
  readonly onRename: (connection: OnshapeConnectionSummary, name: string) => Promise<string | null>;
  readonly onReplaceCredentials: (
    connection: OnshapeConnectionSummary,
    draft: OnshapeCredentialDraft,
  ) => Promise<string | null>;
  readonly onRemove: (connection: OnshapeConnectionSummary) => void;
}) {
  const isRenaming = editor?.kind === "rename" && editor.connectionId === connection.connectionId;
  const isReplacing = editor?.kind === "replace" && editor.connectionId === connection.connectionId;
  const isRemoving = pendingKey === `remove:${connection.connectionId}`;
  const renameFormId = useId();
  const replaceFormId = useId();

  return (
    <article className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-xs/5">
      <div className="flex flex-col gap-4 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/35 text-muted-foreground">
            <LinkIcon className="size-4" aria-hidden />
          </div>
          <div className="min-w-0 space-y-1">
            <h3 className="truncate text-sm font-semibold text-foreground">{connection.name}</h3>
            <p className="truncate font-mono text-xs text-muted-foreground">{connection.host}</p>
            <VerifiedAt value={connection.verifiedAt} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1 sm:justify-end">
          <Button
            data-onshape-focus-key={`rename:${connection.connectionId}`}
            size="sm"
            variant="ghost-muted"
            disabled={interactionsDisabled}
            aria-expanded={isRenaming}
            aria-controls={renameFormId}
            onClick={() => onEdit({ kind: "rename", connectionId: connection.connectionId })}
          >
            <PencilIcon aria-hidden />
            Rename
          </Button>
          <Button
            data-onshape-focus-key={`replace:${connection.connectionId}`}
            size="sm"
            variant="ghost-muted"
            disabled={interactionsDisabled}
            aria-expanded={isReplacing}
            aria-controls={replaceFormId}
            onClick={() => onEdit({ kind: "replace", connectionId: connection.connectionId })}
          >
            <KeyRoundIcon aria-hidden />
            Replace credentials
          </Button>
          <Button
            data-onshape-focus-key={`remove:${connection.connectionId}`}
            size="sm"
            variant="ghost-muted"
            disabled={interactionsDisabled}
            onClick={() => onRemove(connection)}
          >
            {isRemoving ? <Spinner className="size-3.5" aria-hidden /> : <Trash2Icon aria-hidden />}
            Remove
          </Button>
        </div>
      </div>
      {isRenaming ? (
        <RenameConnectionForm
          formId={renameFormId}
          connection={connection}
          pending={pendingKey === `rename:${connection.connectionId}`}
          onCancel={onCancelEdit}
          onSave={(name) => onRename(connection, name)}
        />
      ) : null}
      {isReplacing ? (
        <ReplaceCredentialsForm
          formId={replaceFormId}
          connection={connection}
          pending={pendingKey === `replace:${connection.connectionId}`}
          onCancel={onCancelEdit}
          onSave={(draft) => onReplaceCredentials(connection, draft)}
        />
      ) : null}
    </article>
  );
}

function EnvironmentOnshapeConnections({
  environment,
  deviceTabs,
  onEditorLockChange,
}: {
  readonly environment: EnvironmentPresentation;
  readonly deviceTabs?: ReactNode;
  readonly onEditorLockChange: (disabled: boolean) => void;
}) {
  const environmentId = environment.environmentId;
  const connected = environment.connection.phase === "connected";
  const {
    connections,
    editor,
    pendingKey,
    operationNotice,
    operationCompletion,
    editorInvalidation,
    listError,
    isListPending,
    hasListData,
    interactionsDisabled,
    refresh,
    dismissOperationError,
    openEditor,
    cancelEditor,
    saveCreate,
    saveRename,
    saveReplacement,
    remove,
  } = useOnshapeConnectionsController(environmentId);
  const addFormId = useId();
  const isAdding = editor?.kind === "add";
  const {
    addButtonRef,
    connectionContentRef,
    discardEditButtonRef,
    operationStatusRef,
    unavailableStatusRef,
  } = useOnshapeConnectionsFocus({
    connected,
    editor,
    operationNotice,
    operationCompletion,
    sectionId: onshapeSearchMetadata.id,
  });

  useEffect(() => {
    onEditorLockChange(editor !== null);
    return () => onEditorLockChange(false);
  }, [editor, onEditorLockChange]);

  const beginEditing = (nextEditor: Exclude<OnshapeConnectionEditor, null>) => {
    onEditorLockChange(true);
    openEditor(nextEditor);
  };
  const stopEditing = () => {
    cancelEditor();
    onEditorLockChange(false);
  };
  const removeWithLock = (connection: OnshapeConnectionSummary) => {
    onEditorLockChange(true);
    void remove(connection).finally(() => onEditorLockChange(false));
  };

  const editorInvalidationNotice =
    editorInvalidation !== null ? (
      <Alert variant="warning">
        <TriangleAlertIcon aria-hidden />
        <AlertTitle>Editor closed</AlertTitle>
        <AlertDescription>{editorInvalidation}</AlertDescription>
      </Alert>
    ) : null;

  const staleWarning =
    listError !== null ? (
      <Alert variant="warning">
        <TriangleAlertIcon aria-hidden />
        <AlertDescription>
          These connections may be out of date because the latest list could not be loaded.
        </AlertDescription>
        <AlertAction>
          <Button size="sm" variant="outline" disabled={isListPending} onClick={refresh}>
            Try again
          </Button>
        </AlertAction>
      </Alert>
    ) : null;

  const operationStatus =
    operationNotice?._tag === "Pending" ? (
      <div className="px-3 sm:px-4">
        <Alert ref={operationStatusRef} tabIndex={-1} variant="info" aria-live="polite">
          <Spinner aria-hidden />
          <AlertTitle>Connection change in progress</AlertTitle>
          <AlertDescription>{operationNotice.message}</AlertDescription>
        </Alert>
      </div>
    ) : operationNotice?._tag === "Error" ? (
      <div className="px-3 sm:px-4">
        <Alert ref={operationStatusRef} tabIndex={-1} variant="error">
          <TriangleAlertIcon aria-hidden />
          <AlertTitle>Connection change failed</AlertTitle>
          <AlertDescription>{operationNotice.message}</AlertDescription>
          <AlertAction>
            <Button size="sm" variant="outline" onClick={dismissOperationError}>
              Dismiss
            </Button>
          </AlertAction>
        </Alert>
      </div>
    ) : null;

  const content = (() => {
    if (isListPending && !hasListData) {
      return (
        <SettingsRow
          title="Loading connections"
          description="Reading saved Onshape connections from this device."
          control={<Spinner className="size-4 text-muted-foreground" />}
        />
      );
    }

    if (listError !== null && !hasListData) {
      return (
        <Alert variant="error">
          <TriangleAlertIcon aria-hidden />
          <AlertTitle>Connections could not be loaded</AlertTitle>
          <AlertDescription>
            Reconnect to this device or try loading the list again.
          </AlertDescription>
          <AlertAction>
            <Button size="sm" variant="outline" disabled={isListPending} onClick={refresh}>
              <RefreshCwIcon aria-hidden />
              Try again
            </Button>
          </AlertAction>
        </Alert>
      );
    }

    if (connections.length === 0 && editor?.kind !== "add") {
      return (
        <div className="space-y-3">
          {editorInvalidationNotice}
          {staleWarning}
          <Empty className="rounded-2xl border border-dashed border-border/70 py-10 md:p-10">
            <EmptyMedia variant="icon">
              <LinkIcon aria-hidden />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>No Onshape connections</EmptyTitle>
              <EmptyDescription>
                Add an API key connection before linking an Onshape project.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button
                ref={addButtonRef}
                disabled={interactionsDisabled}
                aria-expanded={isAdding}
                aria-controls={addFormId}
                onClick={() => beginEditing({ kind: "add" })}
              >
                <PlusIcon aria-hidden />
                Add connection
              </Button>
            </EmptyContent>
          </Empty>
        </div>
      );
    }

    return (
      <div className="space-y-3">
        {editorInvalidationNotice}
        {staleWarning}
        {editor?.kind === "add" ? (
          <AddConnectionForm
            formId={addFormId}
            pending={pendingKey === "add"}
            onCancel={stopEditing}
            onSave={saveCreate}
          />
        ) : null}
        {connections.map((connection) => (
          <ConnectionCard
            key={connection.connectionId}
            connection={connection}
            editor={editor}
            pendingKey={pendingKey}
            interactionsDisabled={interactionsDisabled}
            onEdit={beginEditing}
            onCancelEdit={stopEditing}
            onRename={saveRename}
            onReplaceCredentials={saveReplacement}
            onRemove={removeWithLock}
          />
        ))}
      </div>
    );
  })();

  return (
    <SettingsSection
      id={onshapeSearchMetadata.id}
      title="Onshape"
      icon={<LinkIcon className="size-4 text-muted-foreground" aria-hidden />}
      headerAction={
        connected ? (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost-muted"
              disabled={isListPending || interactionsDisabled}
              onClick={refresh}
            >
              <RefreshCwIcon aria-hidden />
              Refresh
            </Button>
            {connections.length > 0 ? (
              <Button
                ref={addButtonRef}
                size="sm"
                variant="outline"
                disabled={interactionsDisabled}
                aria-expanded={isAdding}
                aria-controls={addFormId}
                onClick={() => beginEditing({ kind: "add" })}
              >
                <PlusIcon aria-hidden />
                Add connection
              </Button>
            ) : null}
          </div>
        ) : null
      }
    >
      {deviceTabs}
      {operationStatus}
      {!connected ? (
        <div ref={unavailableStatusRef} tabIndex={-1} role="status" aria-live="polite">
          <SettingsRow
            key="unavailable"
            title="Connections unavailable"
            description={
              operationNotice?._tag === "Pending"
                ? `${operationNotice.message} The change will keep running while this device reconnects.`
                : environment.connection.phase === "available"
                  ? "This device is available but not connected. Connect it before configuring Onshape."
                  : connectionStatusText(environment.connection)
            }
            control={
              editor !== null && pendingKey === null ? (
                <Button
                  ref={discardEditButtonRef}
                  size="sm"
                  variant="outline"
                  onClick={stopEditing}
                >
                  Discard edit
                </Button>
              ) : null
            }
          />
        </div>
      ) : null}
      <div
        ref={connectionContentRef}
        key="connections"
        aria-hidden={connected ? undefined : true}
        inert={connected ? undefined : true}
        className={cn("space-y-3 px-3 sm:px-4", connected ? undefined : "hidden")}
      >
        <p className="max-w-2xl text-[13px] leading-relaxed text-muted-foreground/80">
          Saved connections are available to Onshape projects on this device. Saving or replacing
          credentials contacts Onshape; renaming and refreshing do not use your API quota.
        </p>
        {content}
      </div>
    </SettingsSection>
  );
}

function onshapeEnvironmentIcon(environment: BaseEnvironmentPresentation) {
  if (environment.entry.target._tag === "PrimaryConnectionTarget") return MonitorIcon;
  return LaptopIcon;
}

function onshapeEnvironmentDetail(environment: BaseEnvironmentPresentation): string {
  if (environment.entry.target._tag === "PrimaryConnectionTarget") return "Primary device";
  return "Local environment";
}

export function OnshapeConnectionsSettings({
  initialEnvironmentId,
}: {
  initialEnvironmentId?: EnvironmentId | undefined;
}) {
  const { environments, isReady } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const options = useMemo(
    () =>
      [...environments].sort((left, right) => {
        if (left.environmentId === primaryEnvironmentId) return -1;
        if (right.environmentId === primaryEnvironmentId) return 1;
        return left.label.localeCompare(right.label);
      }),
    [environments, primaryEnvironmentId],
  );
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(
    initialEnvironmentId ?? null,
  );
  const effectiveEnvironmentId = resolveOnshapeSettingsEnvironment(
    options.map((environment) => environment.environmentId),
    selectedEnvironmentId,
    primaryEnvironmentId,
  );
  const selectedEnvironment =
    options.find((environment) => environment.environmentId === effectiveEnvironmentId) ?? null;
  const selectedPendingKey = useOnshapeConnectionPendingKey(effectiveEnvironmentId);
  const selectedPendingKeyRef = useRef(selectedPendingKey);
  selectedPendingKeyRef.current = selectedPendingKey;
  const [environmentEditorLocked, setEnvironmentEditorLocked] = useState(false);
  const environmentInteractionsDisabled = environmentEditorLocked || selectedPendingKey !== null;
  const environmentInteractionsDisabledRef = useRef(environmentInteractionsDisabled);
  environmentInteractionsDisabledRef.current = environmentInteractionsDisabled;
  const updateEnvironmentEditorLock = useCallback((locked: boolean) => {
    environmentInteractionsDisabledRef.current = locked || selectedPendingKeyRef.current !== null;
    setEnvironmentEditorLocked(locked);
  }, []);
  const onlyPrimaryDevice =
    options.length === 1 && options[0]?.entry.target._tag === "PrimaryConnectionTarget";
  const deviceTabs =
    (!onlyPrimaryDevice || selectedEnvironment === null) && options.length > 0 ? (
      <ScrollArea hideScrollbars scrollFade className="mx-3 h-11 min-w-0 rounded-none sm:mx-4">
        <div
          role="group"
          aria-label="Devices"
          className="flex h-full w-max min-w-full border-b border-border/70 px-1"
        >
          {options.map((environment) => {
            const Icon = onshapeEnvironmentIcon(environment);
            const selected = environment.environmentId === effectiveEnvironmentId;
            const detail = onshapeEnvironmentDetail(environment);
            const statusText = connectionStatusText(environment.connection);
            return (
              <Tooltip key={environment.environmentId}>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-pressed={selected}
                      disabled={environmentInteractionsDisabled && !selected}
                      className={cn(
                        providerSettingsTabClassName(selected),
                        "gap-2 text-left disabled:cursor-not-allowed disabled:opacity-50",
                      )}
                      onClick={() => {
                        setSelectedEnvironmentId((current) =>
                          resolveOnshapeEnvironmentSelection(
                            current,
                            environment.environmentId,
                            environmentInteractionsDisabledRef.current,
                          ),
                        );
                      }}
                    >
                      <Icon className="size-3.5 shrink-0" aria-hidden />
                      <span className="max-w-40 truncate">{environment.label}</span>
                      {environment.connection.phase !== "connected" ? (
                        <ConnectionStatusDot
                          dotClassName={connectionPhaseDotClassName(environment.connection.phase)}
                          pingClassName={connectionPhasePingClassName(environment.connection.phase)}
                        />
                      ) : null}
                      <span className="sr-only">
                        {detail}, {statusText}
                      </span>
                    </button>
                  }
                />
                <TooltipPopup side="top">
                  {detail} · {statusText}
                </TooltipPopup>
              </Tooltip>
            );
          })}
        </div>
      </ScrollArea>
    ) : null;

  if (options.length === 0) {
    return (
      <SettingsSection
        id={onshapeSearchMetadata.id}
        title="Onshape"
        icon={<LinkIcon className="size-4 text-muted-foreground" aria-hidden />}
      >
        <SettingsRow
          title={isReady ? "No connected devices" : "Loading devices"}
          description={
            isReady
              ? "Connect an execution environment before configuring Onshape."
              : "Reading connected execution environments."
          }
        />
      </SettingsSection>
    );
  }

  if (selectedEnvironment === null) {
    return (
      <SettingsSection id={onshapeSearchMetadata.id} title="Onshape">
        {deviceTabs}
        <SettingsRow
          title={isReady ? "Device unavailable" : "Loading devices"}
          description={
            isReady
              ? "The device selected for this Onshape project is unavailable. Connect it to manage its connections, or choose another device above."
              : "Reading connected execution environments."
          }
        />
      </SettingsSection>
    );
  }
  return (
    <EnvironmentOnshapeConnections
      key={selectedEnvironment.environmentId}
      environment={selectedEnvironment}
      deviceTabs={deviceTabs}
      onEditorLockChange={updateEnvironmentEditorLock}
    />
  );
}
