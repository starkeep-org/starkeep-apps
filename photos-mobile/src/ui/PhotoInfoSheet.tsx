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
import { photoInfoRows, type PhotoInfoFields } from "@starkeep/photos-info";
import type { DataRecord, MetadataRow } from "@starkeep/protocol-primitives";
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

/**
 * The record and its metadata row, as the shared row builder reads them.
 *
 * Every column is read defensively, because a metadata row is whatever the node
 * that wrote it chose to fill in, and a column of the wrong type is better left
 * out than printed.
 */
export function infoFields(record: DataRecord, row: MetadataRow | null): PhotoInfoFields {
  const num = (column: string): number | null => {
    const value = row?.[column];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  };
  const text = (column: string): string | null => {
    const value = row?.[column];
    return typeof value === "string" && value !== "" ? value : null;
  };
  return {
    originalFilename: record.originalFilename,
    width: num("width"),
    height: num("height"),
    mimeType: record.mimeType,
    sizeBytes: record.sizeBytes,
    // An ISO string from this phone's reader; a number of milliseconds would
    // be printed the same way.
    dateTaken:
      text("captured_at") ??
      (num("captured_at") !== null ? new Date(num("captured_at")!).toISOString() : null),
    cameraMake: text("camera_make"),
    cameraModel: text("camera_model"),
    fNumber: num("f_number"),
    exposureTime: text("exposure_time"),
    iso: num("iso"),
    lensModel: text("lens_model"),
    orientation: num("orientation"),
    gpsLat: num("gps_lat"),
    gpsLon: num("gps_lon"),
  };
}
