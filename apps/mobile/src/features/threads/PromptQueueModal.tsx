import type { QueuedThreadMessage } from "../../state/thread-outbox-model";
import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";

function QueueAction(props: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly destructive?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={props.label}
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      className="min-h-11 justify-center rounded-full bg-subtle px-3 py-2 active:opacity-70 disabled:opacity-35"
    >
      <Text
        className={
          props.destructive
            ? "text-xs font-t3-bold text-danger"
            : "text-xs font-t3-bold text-foreground"
        }
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

export function PromptQueueModal(props: {
  readonly visible: boolean;
  readonly busy: boolean;
  readonly paused: boolean;
  readonly messages: ReadonlyArray<QueuedThreadMessage>;
  readonly onClose: () => void;
  readonly onEdit: (message: QueuedThreadMessage, text: string) => Promise<boolean>;
  readonly onDelete: (message: QueuedThreadMessage) => Promise<boolean>;
  readonly onMove: (message: QueuedThreadMessage, direction: -1 | 1) => Promise<boolean>;
  readonly onSendNow: (message: QueuedThreadMessage) => Promise<boolean>;
  readonly onPause: () => Promise<boolean>;
  readonly onResume: () => Promise<boolean>;
}) {
  const insets = useSafeAreaInsets();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");

  useEffect(() => {
    if (!props.visible) setEditingId(null);
  }, [props.visible]);

  return (
    <Modal
      animationType="slide"
      presentationStyle="pageSheet"
      visible={props.visible}
      onRequestClose={props.onClose}
    >
      <View
        className="flex-1 bg-screen px-4"
        style={{ paddingTop: Math.max(insets.top, 20), paddingBottom: Math.max(insets.bottom, 16) }}
      >
        <View className="mb-4 flex-row items-center justify-between">
          <View>
            <Text className="text-xl font-t3-bold text-foreground">Prompt queue</Text>
            <Text className="mt-0.5 text-sm text-foreground-muted">
              {props.messages.length} queued · {props.paused ? "Paused" : "Auto-run"}
            </Text>
          </View>
          <QueueAction label="Done" onPress={props.onClose} />
        </View>

        <View className="mb-3 flex-row">
          <QueueAction
            label={
              props.paused
                ? "Resume Queue"
                : props.busy
                  ? "Pause after current turn"
                  : "Pause Queue"
            }
            onPress={() => void (props.paused ? props.onResume() : props.onPause())}
          />
        </View>

        <ScrollView contentContainerClassName="gap-2 pb-6" keyboardShouldPersistTaps="handled">
          {props.messages.map((message, index) => {
            const editing = editingId === message.messageId;
            return (
              <View
                key={message.messageId}
                className="rounded-2xl border border-border bg-card p-3"
              >
                <Text className="mb-1 text-xs font-t3-bold text-foreground-muted">{index + 1}</Text>
                {editing ? (
                  <TextInput
                    accessibilityLabel={`Edit queued prompt ${index + 1}`}
                    autoFocus
                    multiline
                    value={editText}
                    onChangeText={setEditText}
                    className="min-h-20 rounded-xl border border-input-border bg-input px-3 py-2 text-base text-foreground"
                  />
                ) : (
                  <Text className="text-sm leading-5 text-foreground" numberOfLines={3}>
                    {message.text || "Attachment-only prompt"}
                  </Text>
                )}
                {message.attachments.length > 0 ? (
                  <Text className="mt-1 text-xs text-foreground-muted">
                    {message.attachments.length} attachment
                    {message.attachments.length === 1 ? "" : "s"}
                  </Text>
                ) : null}
                <View className="mt-3 flex-row flex-wrap gap-2">
                  {editing ? (
                    <>
                      <QueueAction
                        label="Save"
                        disabled={editText.trim().length === 0 && message.attachments.length === 0}
                        onPress={() => {
                          void props.onEdit(message, editText).then((saved) => {
                            if (saved) setEditingId(null);
                          });
                        }}
                      />
                      <QueueAction label="Cancel" onPress={() => setEditingId(null)} />
                    </>
                  ) : (
                    <>
                      <QueueAction
                        label="Edit"
                        onPress={() => {
                          setEditingId(message.messageId);
                          setEditText(message.text);
                        }}
                      />
                      <QueueAction
                        label="Delete"
                        destructive
                        onPress={() => void props.onDelete(message)}
                      />
                      <QueueAction
                        label="Up"
                        disabled={index === 0}
                        onPress={() => void props.onMove(message, -1)}
                      />
                      <QueueAction
                        label="Down"
                        disabled={index === props.messages.length - 1}
                        onPress={() => void props.onMove(message, 1)}
                      />
                      <QueueAction
                        label={props.busy ? "Steer Now" : "Send Now"}
                        onPress={() => {
                          void props.onSendNow(message).then((sent) => {
                            if (sent) props.onClose();
                          });
                        }}
                      />
                    </>
                  )}
                </View>
              </View>
            );
          })}
        </ScrollView>
      </View>
    </Modal>
  );
}
