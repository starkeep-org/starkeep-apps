/**
 * What is known about one photograph, in a sheet over the viewer.
 *
 * The rows are the ones the Photos web app's info panel lists, built by the
 * same function (`photoInfoRows` in `@starkeep/photos-info`), followed by the
 * two facts only this app showed: the record's type and its content hash, which
 * is what a second device matches it by. The sheet itself is this app's own.
 *
 * A photograph this phone took shows fewer rows than the web app shows for it.
 * The phone's own EXIF reader records only the capture time, orientation and
 * dimensions; the camera and exposure rows appear once the Photos app on
 * another node has read the full header and the metadata row has synced back.
 *
 * The sheet also holds Delete, behind a confirmation. It closes before the
 * delete runs: the grid reload that follows closes the viewer under it, and
 * Android's trash dialog then opens over the grid.
 *
 * Above the rows sits the photograph's caption, with "Edit caption". Editing
 * waits until the Photos channel has completed a pull, and the sheet says why
 * while it waits; see `photos/captions.ts`. A saved caption is written here at
 * once and ships on Photos' own channel, on any network.
 */

import { useEffect, useState } from "react";
import { Alert, Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MaterialIcons } from "@expo/vector-icons";
import { photoInfoRows } from "@starkeep/photos-info";
import type { DataRecord, MetadataRow } from "@starkeep/protocol-primitives";
import { MAX_CAPTION_LENGTH, type CaptionStore } from "../photos/captions";
import { deletePrompt, infoFields } from "./info-fields";
import { colors, styles } from "./theme";

export function PhotoInfoSheet({
  record,
  readInfo,
  onDelete,
  captions = null,
  onCaptionChange,
  onClose,
}: {
  /** The record to describe, or null while the sheet is closed. */
  readonly record: DataRecord | null;
  readonly readInfo: (record: DataRecord) => Promise<MetadataRow | null>;
  /** Delete the record everywhere. See `useLibrary().deleteRecord`. */
  readonly onDelete: (record: DataRecord) => Promise<void>;
  /** Photos' captions on this phone; null shows no caption block. */
  readonly captions?: CaptionStore | null;
  /** A caption was saved for a record. */
  readonly onCaptionChange?: (recordId: string, caption: string | null) => void;
  readonly onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [metadata, setMetadata] = useState<MetadataRow | null>(null);
  useEffect(() => {
    setMetadata(null);
    if (!record) return;
    let cancelled = false;
    void readInfo(record).then((row) => {
      if (!cancelled) setMetadata(row);
    });
    return () => {
      cancelled = true;
    };
  }, [record, readInfo]);

  const confirmDelete = (target: DataRecord) => {
    const { title, message } = deletePrompt(target);
    Alert.alert(title, message, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          onClose();
          onDelete(target).catch((err: unknown) =>
            Alert.alert("Could not delete", err instanceof Error ? err.message : String(err)),
          );
        },
      },
    ]);
  };

  return (
    <Modal visible={record !== null} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.sheetBackdrop} onPress={onClose}>
        {/* A `Pressable` that does nothing, so a tap inside the sheet does not
            reach the backdrop and close it. */}
        <Pressable style={[styles.sheet, { paddingBottom: 16 + insets.bottom }]} onPress={() => {}}>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>Photo info</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close"
              onPress={onClose}
              style={styles.iconButton}
            >
              <MaterialIcons name="close" size={22} color={colors.muted} />
            </Pressable>
          </View>
          {record ? (
            <ScrollView keyboardShouldPersistTaps="handled">
              {captions ? (
                <CaptionBlock
                  key={record.id}
                  record={record}
                  captions={captions}
                  {...(onCaptionChange ? { onChange: onCaptionChange } : {})}
                />
              ) : null}
              {photoInfoRows(infoFields(record, metadata)).map((row) => (
                <InfoLine key={row.label} label={row.label} value={row.value} />
              ))}
              <InfoLine label="Type" value={record.type} />
              {record.contentHash ? (
                <InfoLine label="Content hash" value={record.contentHash} mono />
              ) : null}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Delete"
                onPress={() => confirmDelete(record)}
                style={styles.sheetDelete}
              >
                <MaterialIcons name="delete-outline" size={20} color={colors.danger} />
                <Text style={styles.sheetDeleteLabel}>Delete</Text>
              </Pressable>
            </ScrollView>
          ) : null}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/**
 * The caption, and "Edit caption", which opens a text field prefilled with it.
 * Keyed by record in the sheet, so moving to another photograph starts over.
 */
function CaptionBlock({
  record,
  captions,
  onChange,
}: {
  readonly record: DataRecord;
  readonly captions: CaptionStore;
  readonly onChange?: (recordId: string, caption: string | null) => void;
}) {
  const [caption, setCaption] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let cancelled = false;
    captions
      .get(record.id)
      .then((text) => {
        if (!cancelled) setCaption(text);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [record, captions]);

  const blocked = captions.editBlockedReason();

  const save = async (text: string) => {
    setSaving(true);
    try {
      const stored = await captions.set(record.id, text);
      setCaption(stored);
      setDraft(null);
      onChange?.(record.id, stored);
    } catch (err) {
      Alert.alert("Could not save the caption", err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (draft !== null) {
    return (
      <View style={styles.sheetCaption}>
        <TextInput
          accessibilityLabel="Caption"
          value={draft}
          onChangeText={setDraft}
          multiline
          autoFocus
          maxLength={MAX_CAPTION_LENGTH}
          placeholder="Add a caption"
          placeholderTextColor={colors.muted}
          style={[styles.input, styles.captionInput]}
        />
        <View style={styles.sheetCaptionActions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel"
            onPress={() => setDraft(null)}
            disabled={saving}
            style={styles.sheetCaptionAction}
          >
            <Text style={styles.linkLabel}>Cancel</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Save"
            onPress={() => void save(draft)}
            disabled={saving}
            style={[styles.button, styles.sheetCaptionAction, saving && styles.buttonDisabled]}
          >
            <Text style={styles.buttonLabel}>{saving ? "Saving…" : "Save"}</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.sheetCaption}>
      {caption ? <Text style={styles.sheetCaptionText}>{caption}</Text> : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Edit caption"
        accessibilityState={{ disabled: blocked !== null }}
        disabled={blocked !== null}
        onPress={() => setDraft(caption ?? "")}
        style={[styles.sheetEditCaption, blocked !== null && styles.buttonDisabled]}
      >
        <MaterialIcons name="edit" size={20} color={colors.accent} />
        <Text style={styles.sheetEditCaptionLabel}>Edit caption</Text>
      </Pressable>
      {blocked !== null ? <Text style={styles.muted}>{blocked}</Text> : null}
    </View>
  );
}

function InfoLine({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={mono ? styles.infoValueMono : styles.infoValue} selectable>
        {value}
      </Text>
    </View>
  );
}
