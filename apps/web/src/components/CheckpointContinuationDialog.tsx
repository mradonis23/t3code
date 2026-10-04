import { useEffect, useMemo, useState } from "react";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";

import {
  resolveCheckpointContinuationActionState,
  type CheckpointContinuation,
  type CheckpointContinuationSubmissionIntent,
} from "@t3tools/shared/checkpointContinuation";
import { writeTextToClipboard } from "../hooks/useCopyToClipboard";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Textarea } from "./ui/textarea";
export interface CheckpointContinuationDialogProps {
  readonly open: boolean;
  readonly continuation: CheckpointContinuation | null;
  readonly connectionState: EnvironmentConnectionPhase;
  readonly sessionStatus:
    | "idle"
    | "starting"
    | "running"
    | "ready"
    | "interrupted"
    | "stopped"
    | "error"
    | null;
  readonly latestTurnState: "running" | "interrupted" | "completed" | "error" | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (
    text: string,
    intent: CheckpointContinuationSubmissionIntent,
  ) => Promise<boolean>;
}

export function CheckpointContinuationDialog(props: CheckpointContinuationDialogProps) {
  const [draftText, setDraftText] = useState("");
  const [editing, setEditing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    if (!props.open || !props.continuation) return;
    setDraftText(props.continuation.prompt);
    setEditing(false);
    setSubmitting(false);
    setCopied(false);
    setFailure(null);
  }, [props.continuation, props.open]);

  const actions = useMemo(() => {
    if (!props.continuation) return null;
    return resolveCheckpointContinuationActionState({
      continuationKind: props.continuation.kind,
      connectionState: props.connectionState,
      sessionStatus: props.sessionStatus,
      latestTurnState: props.latestTurnState,
    });
  }, [props.connectionState, props.continuation, props.latestTurnState, props.sessionStatus]);

  const submit = async (intent: CheckpointContinuationSubmissionIntent) => {
    const text = draftText.trim();
    if (!text || submitting) return;
    setSubmitting(true);
    setFailure(null);
    try {
      const submitted = await props.onSubmit(text, intent);
      if (submitted) {
        props.onOpenChange(false);
      } else {
        setFailure("The continuation could not be saved. Your edited text is still here.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  const copy = async () => {
    const didCopy = await writeTextToClipboard(draftText, "checkpoint continuation");
    setCopied(didCopy);
    setFailure(didCopy ? null : "Could not copy the continuation.");
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Continue from checkpoint</DialogTitle>
          <DialogDescription>
            Built from recorded thread, checkpoint, command, and Git evidence. Preview or edit the
            exact continuation before sending it.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          <div className="flex gap-2">
            <Button
              size="sm"
              variant={editing ? "outline" : "default"}
              onClick={() => setEditing(false)}
            >
              Preview
            </Button>
            <Button
              size="sm"
              variant={editing ? "default" : "outline"}
              onClick={() => setEditing(true)}
            >
              Edit
            </Button>
          </div>
          {editing ? (
            <Textarea
              aria-label="Edit checkpoint continuation text"
              autoFocus
              value={draftText}
              onChange={(event) => {
                setDraftText(event.currentTarget.value);
                setCopied(false);
                setFailure(null);
              }}
              className="min-h-80 font-mono text-xs"
            />
          ) : (
            <pre className="max-h-[55vh] overflow-auto whitespace-pre-wrap rounded-xl border border-border bg-muted/35 p-4 text-xs leading-relaxed text-foreground">
              {draftText}
            </pre>
          )}
          {failure ? <p className="text-sm text-destructive">{failure}</p> : null}
        </DialogPanel>
        <DialogFooter className="flex-wrap">
          <Button
            variant="outline"
            disabled={submitting || draftText.trim().length === 0}
            onClick={() => void copy()}
          >
            {copied ? "Copied" : "Copy continuation"}
          </Button>
          {actions?.primaryAction === "continue-now" ? (
            <Button
              disabled={submitting || draftText.trim().length === 0}
              onClick={() => void submit("now")}
            >
              {submitting ? "Continuing..." : "Continue now"}
            </Button>
          ) : (
            <Button
              disabled={submitting || draftText.trim().length === 0}
              onClick={() => void submit("later")}
            >
              {submitting ? "Queuing..." : "Queue continuation"}
            </Button>
          )}
          {actions?.primaryAction === "continue-now" ? (
            <Button
              variant="outline"
              disabled={submitting || draftText.trim().length === 0}
              onClick={() => void submit("later")}
            >
              Queue for later
            </Button>
          ) : null}
          {actions?.canSteer ? (
            <Button
              variant="destructive"
              disabled={submitting || draftText.trim().length === 0}
              onClick={() => void submit("steer")}
            >
              Steer active turn
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
