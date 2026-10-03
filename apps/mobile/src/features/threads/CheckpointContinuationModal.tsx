import { useEffect, useMemo, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import {
  resolveCheckpointContinuationActionState,
  type CheckpointContinuation,
  type CheckpointContinuationSubmissionIntent,
} from "./checkpointContinuation.logic";

function ModalAction(props: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly primary?: boolean;
  readonly destructive?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={props.label}
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      className={
        props.primary
          ? "min-h-11 w-full items-center justify-center rounded-full bg-primary px-4 py-2.5 active:opacity-70 disabled:opacity-35"
          : "min-h-11 w-full items-center justify-center rounded-full bg-subtle px-4 py-2.5 active:opacity-70 disabled:opacity-35"
      }
    >
      <Text
        className={
          props.primary
            ? "text-sm font-t3-bold text-primary-foreground"
            : props.destructive
              ? "text-sm font-t3-bold text-danger"
              : "text-sm font-t3-bold text-foreground"
        }
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

export function CheckpointContinuationModal(props: {
  readonly visible: boolean;
  readonly continuation: CheckpointContinuation;
  readonly connectionState:
    | "available"
    | "connecting"
    | "reconnecting"
    | "connected"
    | "offline"
    | "error";
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
  readonly onClose: () => void;
  readonly onSubmit: (
    text: string,
    intent: CheckpointContinuationSubmissionIntent,
  ) => Promise<boolean>;
}) {
  const insets = useSafeAreaInsets();
  const [draftText, setDraftText] = useState(props.continuation.prompt);
  const [editing, setEditing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const wasVisibleRef = useRef(false);
  const actions = useMemo(
    () =>
      resolveCheckpointContinuationActionState({
        continuationKind: props.continuation.kind,
        connectionState: props.connectionState,
        sessionStatus: props.sessionStatus,
        latestTurnState: props.latestTurnState,
      }),
    [props.connectionState, props.continuation.kind, props.latestTurnState, props.sessionStatus],
  );

  useEffect(() => {
    if (props.visible && !wasVisibleRef.current) {
      setDraftText(props.continuation.prompt);
      setEditing(false);
      setSubmitting(false);
      setCopied(false);
      setFailure(null);
    }
    wasVisibleRef.current = props.visible;
  }, [props.continuation.prompt, props.visible]);

  const copy = async () => {
    const copiedSuccessfully = await tryCopyTextWithHaptic(draftText, {
      target: "checkpoint continuation",
    });
    setCopied(copiedSuccessfully);
    if (!copiedSuccessfully) setFailure("Could not copy the continuation.");
  };

  const submit = async (intent: CheckpointContinuationSubmissionIntent) => {
    const text = draftText.trim();
    if (!text || submitting) return;
    setSubmitting(true);
    setFailure(null);
    const submitted = await props.onSubmit(text, intent);
    setSubmitting(false);
    if (submitted) {
      props.onClose();
    } else {
      setFailure("The continuation could not be saved. Your edited text is still here.");
    }
  };

  return (
    <Modal
      animationType="slide"
      presentationStyle="pageSheet"
      visible={props.visible}
      onRequestClose={props.onClose}
    >
      <KeyboardAvoidingView
        className="flex-1 bg-screen"
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View
          className="flex-1 px-4"
          style={{
            paddingTop: Math.max(insets.top, 20),
            paddingBottom: Math.max(insets.bottom, 16),
          }}
        >
          <View className="mb-3 flex-row items-start gap-3">
            <View className="min-w-0 flex-1">
              <Text className="text-xl font-t3-bold text-foreground">Continue from checkpoint</Text>
              <Text className="mt-0.5 text-sm leading-5 text-foreground-muted">
                Built from recorded thread, checkpoint, command, and Git evidence. Preview is the
                exact text that will be copied or submitted.
              </Text>
            </View>
            <Pressable
              accessibilityLabel="Close continuation"
              accessibilityRole="button"
              disabled={submitting}
              onPress={props.onClose}
              className="min-h-11 justify-center rounded-full bg-subtle px-3 active:opacity-70 disabled:opacity-35"
            >
              <Text className="text-sm font-t3-bold text-foreground">Done</Text>
            </Pressable>
          </View>

          <View className="mb-3 flex-row gap-2">
            <Pressable
              accessibilityLabel="Preview continuation"
              accessibilityRole="button"
              onPress={() => setEditing(false)}
              className={`min-h-11 flex-1 items-center justify-center rounded-full px-3 ${
                editing ? "bg-subtle" : "bg-primary"
              }`}
            >
              <Text
                className={`text-sm font-t3-bold ${
                  editing ? "text-foreground" : "text-primary-foreground"
                }`}
              >
                Preview
              </Text>
            </Pressable>
            <Pressable
              accessibilityLabel="Edit continuation"
              accessibilityRole="button"
              onPress={() => setEditing(true)}
              className={`min-h-11 flex-1 items-center justify-center rounded-full px-3 ${
                editing ? "bg-primary" : "bg-subtle"
              }`}
            >
              <Text
                className={`text-sm font-t3-bold ${
                  editing ? "text-primary-foreground" : "text-foreground"
                }`}
              >
                Edit
              </Text>
            </Pressable>
          </View>

          <View className="min-h-0 flex-1 rounded-2xl border border-border bg-card">
            {editing ? (
              <TextInput
                accessibilityLabel="Edit checkpoint continuation text"
                autoFocus
                multiline
                textAlignVertical="top"
                value={draftText}
                onChangeText={(value) => {
                  setDraftText(value);
                  setCopied(false);
                  setFailure(null);
                }}
                className="h-full px-3.5 py-3 text-sm leading-5 text-foreground"
              />
            ) : (
              <ScrollView contentContainerClassName="px-3.5 py-3">
                <Text selectable className="text-sm leading-5 text-foreground">
                  {draftText}
                </Text>
              </ScrollView>
            )}
          </View>

          {failure ? <Text className="mt-2 text-sm text-danger">{failure}</Text> : null}
          <View className="mt-3 gap-2">
            <ModalAction
              label={copied ? "Copied" : "Copy continuation"}
              disabled={submitting || draftText.trim().length === 0}
              onPress={() => void copy()}
            />
            {actions.primaryAction === "continue-now" ? (
              <ModalAction
                primary
                label={submitting ? "Continuing…" : "Continue now"}
                disabled={submitting || draftText.trim().length === 0}
                onPress={() => void submit("now")}
              />
            ) : (
              <ModalAction
                primary
                label={submitting ? "Queuing…" : "Queue continuation"}
                disabled={submitting || draftText.trim().length === 0}
                onPress={() => void submit("later")}
              />
            )}
            {actions.primaryAction === "continue-now" ? (
              <ModalAction
                label="Queue for later"
                disabled={submitting || draftText.trim().length === 0}
                onPress={() => void submit("later")}
              />
            ) : null}
            {actions.canSteer ? (
              <ModalAction
                destructive
                label="Steer active turn"
                disabled={submitting || draftText.trim().length === 0}
                onPress={() => void submit("steer")}
              />
            ) : null}
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
