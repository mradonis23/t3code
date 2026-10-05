import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FlatList, Modal, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import {
  changeTone,
  REVIEW_MONO_FONT_FAMILY,
  renderVisibleWhitespace,
} from "../review/reviewDiffRendering";
import type { AcodeEditDiff, AcodeEditDiffLine } from "./acode-edit-session";

function ReviewActionButton(props: {
  readonly label: string;
  readonly accessibilityLabel: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly destructive?: boolean;
}) {
  return (
    <Pressable
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="button"
      className={
        props.destructive
          ? "min-h-11 flex-1 items-center justify-center rounded-xl bg-danger px-3 disabled:opacity-40"
          : "min-h-11 flex-1 items-center justify-center rounded-xl bg-subtle px-3 disabled:opacity-40"
      }
      disabled={props.disabled}
      onPress={props.onPress}
    >
      <Text
        className={
          props.destructive
            ? "text-center text-sm font-t3-bold text-danger-foreground"
            : "text-center text-sm font-t3-bold text-foreground-secondary"
        }
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

function DiffRow({ line }: { readonly line: AcodeEditDiffLine }) {
  const prefix = line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " ";
  return (
    <View className={`flex-row ${changeTone(line.kind === "remove" ? "delete" : line.kind)}`}>
      <Text
        className="w-8 shrink-0 px-1.5 py-1 text-right text-xs text-foreground-muted"
        style={{ fontFamily: REVIEW_MONO_FONT_FAMILY }}
      >
        {prefix}
      </Text>
      <Text
        selectable
        className="min-w-0 flex-1 px-1.5 py-1 text-xs text-foreground"
        style={{ fontFamily: REVIEW_MONO_FONT_FAMILY }}
      >
        {renderVisibleWhitespace(line.text || " ")}
      </Text>
    </View>
  );
}

export function AcodeEditReviewSheet(props: {
  readonly visible: boolean;
  readonly path: string;
  readonly diff: AcodeEditDiff;
  readonly applying: boolean;
  readonly conflict?: boolean;
  readonly onClose: () => void;
  readonly onApply: () => void;
  readonly onDiscard: () => void;
  readonly onReviewLatest?: () => void;
  readonly onUseHost?: () => void;
  readonly onOverwrite?: () => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal
      animationType="slide"
      onRequestClose={props.onClose}
      statusBarTranslucent
      visible={props.visible}
    >
      <View className="flex-1 bg-sheet" style={{ paddingTop: insets.top }}>
        <View className="flex-row items-center gap-2 border-b border-border px-3 py-2">
          <Pressable
            accessibilityLabel="Close Acode diff"
            accessibilityRole="button"
            className="size-11 items-center justify-center rounded-xl bg-subtle"
            onPress={props.onClose}
          >
            <SymbolView
              name="chevron.left"
              size={22}
              tintColorClassName="accent-icon"
              type="monochrome"
            />
          </Pressable>
          <View className="min-w-0 flex-1">
            <Text className="text-base font-t3-bold text-foreground">Acode changes</Text>
            <Text className="text-xs text-foreground-muted" numberOfLines={1}>
              {props.path}
            </Text>
          </View>
        </View>
        <View className="gap-1 border-b border-border px-3 py-2">
          <Text className="text-sm font-t3-bold text-foreground">
            +{props.diff.additions} / -{props.diff.deletions}
          </Text>
          <Text className="text-xs text-foreground-muted">
            {props.conflict
              ? "The host file changed since this Acode edit began. T3 has not overwritten it."
              : "Original host content compared with the saved Acode snapshot."}
          </Text>
        </View>
        <FlatList
          contentContainerClassName="pb-3"
          data={props.diff.lines}
          keyExtractor={(line, index) => `${index}:${line.kind}:${line.text}`}
          renderItem={({ item }) => <DiffRow line={item} />}
          initialNumToRender={80}
          keyboardShouldPersistTaps="handled"
          maxToRenderPerBatch={80}
          windowSize={9}
        />
        {props.conflict ? (
          <View
            className="flex-row flex-wrap gap-2 border-t border-border px-3 pt-2"
            style={{ paddingBottom: Math.max(insets.bottom, 12) }}
          >
            <ReviewActionButton
              accessibilityLabel="Review latest host file"
              disabled={props.applying}
              label="Review latest"
              onPress={props.onReviewLatest ?? props.onClose}
            />
            <ReviewActionButton
              accessibilityLabel="Use host and discard Acode edit"
              disabled={props.applying}
              label="Use host / Discard"
              onPress={props.onUseHost ?? props.onClose}
            />
            <ReviewActionButton
              accessibilityLabel="Overwrite host file intentionally"
              disabled={props.applying}
              destructive
              label="Overwrite intentionally"
              onPress={props.onOverwrite ?? props.onClose}
            />
            <ReviewActionButton
              accessibilityLabel="Cancel host conflict"
              disabled={props.applying}
              label="Cancel"
              onPress={props.onClose}
            />
          </View>
        ) : (
          <View
            className="flex-row flex-wrap gap-2 border-t border-border px-3 pt-2"
            style={{ paddingBottom: Math.max(insets.bottom, 12) }}
          >
            <ReviewActionButton
              accessibilityLabel="Close Acode diff"
              disabled={props.applying}
              label="Close"
              onPress={props.onClose}
            />
            <ReviewActionButton
              accessibilityLabel="Discard Acode edit"
              disabled={props.applying}
              destructive
              label="Discard"
              onPress={props.onDiscard}
            />
            <ReviewActionButton
              accessibilityLabel="Apply Acode edit to workspace"
              disabled={props.applying}
              label={props.applying ? "Applying…" : "Apply to Workspace"}
              onPress={props.onApply}
            />
          </View>
        )}
      </View>
    </Modal>
  );
}
