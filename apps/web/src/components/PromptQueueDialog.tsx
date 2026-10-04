import { useEffect, useState } from "react";

import type { PromptQueueEntry } from "../promptQueueStore";
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

export interface PromptQueueDialogProps {
  readonly open: boolean;
  readonly busy: boolean;
  readonly paused: boolean;
  readonly entries: ReadonlyArray<PromptQueueEntry>;
  readonly onOpenChange: (open: boolean) => void;
  readonly onEdit: (entry: PromptQueueEntry, text: string) => boolean;
  readonly onDelete: (entry: PromptQueueEntry) => boolean;
  readonly onMove: (entry: PromptQueueEntry, direction: -1 | 1) => boolean;
  readonly onSendNow: (entry: PromptQueueEntry) => boolean;
  readonly onPause: () => boolean;
  readonly onResume: () => boolean;
}
export function PromptQueueDialog(props: PromptQueueDialogProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");

  useEffect(() => {
    if (!props.open) setEditingId(null);
  }, [props.open]);

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Prompt queue</DialogTitle>
          <DialogDescription>
            {props.entries.length} queued · {props.paused ? "Paused" : "Auto-run"}. Reorder, edit,
            pause, or steer the active turn without losing queued work.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => void (props.paused ? props.onResume() : props.onPause())}
            >
              {props.paused
                ? "Resume Queue"
                : props.busy
                  ? "Pause after current turn"
                  : "Pause Queue"}
            </Button>
          </div>
          {props.entries.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              No queued prompts.
            </div>
          ) : (
            <div className="space-y-2">
              {props.entries.map((entry, index) => {
                const editing = editingId === entry.id;
                const attachmentCount = entry.images.length + entry.files.length;
                return (
                  <div key={entry.id} className="rounded-xl border border-border bg-card p-3">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-xs font-medium text-muted-foreground">
                        #{index + 1}
                      </span>
                      <span className="text-xs text-muted-foreground">{entry.deliveryMode}</span>
                    </div>
                    {editing ? (
                      <Textarea
                        aria-label={`Edit queued prompt ${index + 1}`}
                        autoFocus
                        value={editText}
                        onChange={(event) => setEditText(event.currentTarget.value)}
                        className="mt-2 min-h-28"
                      />
                    ) : (
                      <p className="mt-2 line-clamp-4 whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                        {entry.text || "Attachment-only prompt"}
                      </p>
                    )}
                    {attachmentCount > 0 ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {attachmentCount} attachment{attachmentCount === 1 ? "" : "s"}
                      </p>
                    ) : null}
                    {(entry.droppedImageNames?.length ?? 0) > 0 ||
                    (entry.unreadableImageNames?.length ?? 0) > 0 ? (
                      <p className="mt-1 text-xs text-destructive">
                        Some queued images were not preserved. Review this item.
                      </p>
                    ) : null}
                    <div className="mt-3 flex flex-wrap gap-2">
                      {editing ? (
                        <>
                          <Button
                            size="xs"
                            disabled={editText.trim().length === 0 && attachmentCount === 0}
                            onClick={() => {
                              if (props.onEdit(entry, editText)) setEditingId(null);
                            }}
                          >
                            Save
                          </Button>
                          <Button size="xs" variant="outline" onClick={() => setEditingId(null)}>
                            Cancel
                          </Button>
                        </>
                      ) : (
                        <>
                          <Button
                            size="xs"
                            variant="outline"
                            onClick={() => {
                              setEditingId(entry.id);
                              setEditText(entry.text);
                            }}
                          >
                            Edit
                          </Button>
                          <Button size="xs" variant="outline" onClick={() => props.onDelete(entry)}>
                            Delete
                          </Button>
                          <Button
                            size="xs"
                            variant="outline"
                            disabled={index === 0}
                            onClick={() => props.onMove(entry, -1)}
                          >
                            Up
                          </Button>
                          <Button
                            size="xs"
                            variant="outline"
                            disabled={index === props.entries.length - 1}
                            onClick={() => props.onMove(entry, 1)}
                          >
                            Down
                          </Button>
                          <Button
                            size="xs"
                            onClick={() => {
                              if (props.onSendNow(entry)) props.onOpenChange(false);
                            }}
                          >
                            {props.busy ? "Steer Now" : "Send Now"}
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
