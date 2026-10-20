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
 */

import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MaterialIcons } from "@expo/vector-icons";
import { photoInfoRows } from "@starkeep/photos-info";
import type { DataRecord, MetadataRow } from "@starkeep/protocol-primitives";
import { infoFields } from "./info-fields";
import { colors, styles } from "./theme";

export function PhotoInfoSheet({
  record,
  readInfo,
  onClose,
}: {
  /** The record to describe, or null while the sheet is closed. */
  readonly record: DataRecord | null;
  readonly readInfo: (record: DataRecord) => Promise<MetadataRow | null>;
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
            <ScrollView>
              {photoInfoRows(infoFields(record, metadata)).map((row) => (
                <InfoLine key={row.label} label={row.label} value={row.value} />
              ))}
              <InfoLine label="Type" value={record.type} />
              {record.contentHash ? (
                <InfoLine label="Content hash" value={record.contentHash} mono />
              ) : null}
            </ScrollView>
          ) : null}
        </Pressable>
      </Pressable>
    </Modal>
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
