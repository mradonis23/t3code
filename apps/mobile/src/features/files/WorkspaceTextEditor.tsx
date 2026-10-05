import { useNavigation, usePreventRemove } from "@react-navigation/native";
import { useCallback, useMemo, useRef, useState, type ComponentProps } from "react";
import { Alert, Pressable, ScrollView, TextInput as NativeTextInput, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { REVIEW_MONO_FONT_FAMILY } from "../review/reviewDiffRendering";
import {
  createWorkspaceEditorState,
  editWorkspaceText,
  findWorkspaceText,
  offsetForLine,
  redoWorkspaceText,
  undoWorkspaceText,
} from "./workspace-editor-state";

export type WorkspaceEditorSaveResult =
  | { readonly status: "saved"; readonly revision: string }
  | { readonly status: "conflict" }
  | { readonly status: "failed"; readonly message: string };

function EditorToolbarButton(props: {
  readonly accessibilityLabel: string;
  readonly disabled?: boolean;
  readonly icon: ComponentProps<typeof SymbolView>["name"];
  readonly label: string;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="button"
      disabled={props.disabled}
      className="min-h-10 flex-row items-center gap-1.5 rounded-xl bg-subtle px-3 disabled:opacity-40"
      onPress={props.onPress}
    >
      <SymbolView name={props.icon} size={15} tintColorClassName="accent-icon" type="monochrome" />
      <Text className="text-xs font-t3-bold text-foreground-secondary">{props.label}</Text>
    </Pressable>
  );
}

export function WorkspaceTextEditor(props: {
  readonly contents: string;
  readonly path: string;
  readonly revision: string;
  readonly initialLine?: number | null;
  readonly onCancel: () => void;
  readonly onReloadLatest: () => Promise<void> | void;
  readonly onSave: (contents: string, overwrite: boolean) => Promise<WorkspaceEditorSaveResult>;
}) {
  const navigation = useNavigation();
  const [history, setHistory] = useState(() => createWorkspaceEditorState(props.contents));
  const [baseline, setBaseline] = useState({ contents: props.contents, revision: props.revision });
  const [findVisible, setFindVisible] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [lineQuery, setLineQuery] = useState(
    props.initialLine && props.initialLine > 0 ? String(props.initialLine) : "",
  );
  const [selection, setSelection] = useState<{ start: number; end: number } | undefined>(() => {
    if (!props.initialLine || props.initialLine < 1) return undefined;
    const offset = offsetForLine(props.contents, props.initialLine);
    return { start: offset, end: offset };
  });
  const [saving, setSaving] = useState(false);
  const editorRef = useRef<NativeTextInput>(null);
  const gutterRef = useRef<ScrollView>(null);
  const dirty = history.value !== baseline.contents;
  const lineCount = useMemo(() => history.value.split("\n").length, [history.value]);

  usePreventRemove(dirty, ({ data }) => {
    Alert.alert("Discard unsaved changes?", props.path, [
      { text: "Keep editing", style: "cancel" },
      {
        text: "Discard",
        style: "destructive",
        onPress: () => navigation.dispatch(data.action),
      },
    ]);
  });

  const applySelection = useCallback((next: { start: number; end: number }) => {
    setSelection(next);
    editorRef.current?.focus();
  }, []);

  const findNext = useCallback(() => {
    const match = findWorkspaceText(history.value, findQuery, (selection?.end ?? 0) + 1);
    if (match === null) {
      Alert.alert("No match", `“${findQuery}” was not found in this file.`);
      return;
    }
    applySelection(match);
  }, [applySelection, findQuery, history.value, selection?.end]);

  const jumpToLine = useCallback(() => {
    const line = Number(lineQuery);
    if (!Number.isInteger(line) || line < 1) return;
    const offset = offsetForLine(history.value, line);
    applySelection({ start: offset, end: offset });
  }, [applySelection, history.value, lineQuery]);

  const finishSave = useCallback(
    async (overwrite: boolean) => {
      if (!dirty || saving) return;
      setSaving(true);
      try {
        const result = await props.onSave(history.value, overwrite);
        if (result.status === "saved") {
          setBaseline({ contents: history.value, revision: result.revision });
          setHistory(createWorkspaceEditorState(history.value));
          return;
        }
        if (result.status === "conflict") {
          Alert.alert(
            "File changed on host",
            "A newer host version exists. T3 did not overwrite it.",
            [
              { text: "Cancel", style: "cancel" },
              {
                text: "Review latest",
                onPress: () => {
                  void props.onReloadLatest();
                },
              },
              {
                text: "Overwrite",
                style: "destructive",
                onPress: () => {
                  void finishSave(true);
                },
              },
            ],
          );
          return;
        }
        Alert.alert("Could not save", result.message);
      } finally {
        setSaving(false);
      }
    },
    [dirty, history.value, props, saving],
  );

  const handleScroll = useCallback((event: { nativeEvent: { contentOffset: { y: number } } }) => {
    gutterRef.current?.scrollTo({ y: event.nativeEvent.contentOffset.y, animated: false });
  }, []);

  return (
    <View className="flex-1 bg-sheet">
      <View className="gap-2 border-b border-border px-3 py-2">
        <View className="flex-row flex-wrap items-center gap-2">
          <EditorToolbarButton
            accessibilityLabel="Undo file edit"
            disabled={history.undo.length === 0}
            icon="arrow.uturn.backward"
            label="Undo"
            onPress={() => setHistory(undoWorkspaceText)}
          />
          <EditorToolbarButton
            accessibilityLabel="Redo file edit"
            disabled={history.redo.length === 0}
            icon="arrow.uturn.forward"
            label="Redo"
            onPress={() => setHistory(redoWorkspaceText)}
          />
          <EditorToolbarButton
            accessibilityLabel="Find in file"
            icon="magnifyingglass"
            label="Find"
            onPress={() => setFindVisible((value) => !value)}
          />
          <EditorToolbarButton
            accessibilityLabel={dirty ? "Save file, unsaved changes" : "Save file"}
            disabled={!dirty || saving}
            icon="square.and.arrow.down"
            label={saving ? "Saving…" : dirty ? "Save •" : "Saved"}
            onPress={() => void finishSave(false)}
          />
          <EditorToolbarButton
            accessibilityLabel="Close editor"
            icon="xmark"
            label="Close"
            onPress={() => {
              if (!dirty) {
                props.onCancel();
                return;
              }
              Alert.alert("Discard unsaved changes?", props.path, [
                { text: "Keep editing", style: "cancel" },
                { text: "Discard", style: "destructive", onPress: props.onCancel },
              ]);
            }}
          />
        </View>
        <View className="flex-row items-center gap-2">
          <TextInput
            accessibilityLabel="Jump to line"
            className="min-h-10 w-24 rounded-xl py-2 text-sm"
            inputMode="numeric"
            placeholder="Line"
            returnKeyType="go"
            value={lineQuery}
            onChangeText={setLineQuery}
            onSubmitEditing={jumpToLine}
          />
          {findVisible ? (
            <TextInput
              accessibilityLabel="Find text"
              autoCapitalize="none"
              autoCorrect={false}
              className="min-h-10 min-w-0 flex-1 rounded-xl py-2 text-sm"
              placeholder="Find in file"
              returnKeyType="search"
              value={findQuery}
              onChangeText={setFindQuery}
              onSubmitEditing={findNext}
            />
          ) : (
            <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
              {dirty ? "Unsaved changes" : `Revision ${baseline.revision.slice(0, 8)}`}
            </Text>
          )}
          {findVisible ? (
            <EditorToolbarButton
              accessibilityLabel="Find next"
              disabled={findQuery.length === 0}
              icon="chevron.down"
              label="Next"
              onPress={findNext}
            />
          ) : (
            <EditorToolbarButton
              accessibilityLabel="Jump to selected line"
              disabled={!lineQuery}
              icon="arrow.right"
              label="Go"
              onPress={jumpToLine}
            />
          )}
        </View>
      </View>
      <View className="min-w-0 flex-1 flex-row">
        <ScrollView
          ref={gutterRef}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          pointerEvents="none"
          scrollEnabled={false}
          className="w-12 border-r border-border bg-card"
          contentContainerStyle={{ paddingVertical: 12 }}
        >
          <Text
            className="pr-2 text-right text-xs text-foreground-tertiary"
            style={{ fontFamily: REVIEW_MONO_FONT_FAMILY, lineHeight: 20 }}
          >
            {Array.from({ length: lineCount }, (_, index) => index + 1).join("\n")}
          </Text>
        </ScrollView>
        <NativeTextInput
          ref={editorRef}
          accessibilityLabel={`Edit ${props.path}`}
          autoCapitalize="none"
          autoCorrect={false}
          multiline
          selection={selection}
          selectionColor="#6699ff"
          textAlignVertical="top"
          value={history.value}
          className="min-w-0 flex-1 bg-sheet px-3 py-3 text-foreground"
          style={{ fontFamily: REVIEW_MONO_FONT_FAMILY, fontSize: 13, lineHeight: 20 }}
          onChangeText={(value) => setHistory((current) => editWorkspaceText(current, value))}
          onScroll={handleScroll}
          onSelectionChange={(event) => setSelection(event.nativeEvent.selection)}
        />
      </View>
    </View>
  );
}
