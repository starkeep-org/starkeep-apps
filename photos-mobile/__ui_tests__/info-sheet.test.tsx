/**
 * The info sheet over the viewer.
 *
 * `info-fields.test.ts` covers the mapping and `photo-info-rows.test.ts` the
 * rows. These pin how the sheet puts them together: the metadata row it reads
 * for the open record, the shared rows built from it, then Type and Content
 * hash, and nothing from a read for a record the sheet has since moved past.
 * The last case pins Delete: confirmed, it closes the sheet and then deletes.
 * The caption cases pin "Edit caption": the field it opens, Save and Cancel,
 * and the disabled state before the Photos channel has pulled.
 */
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { Alert, Text } from "react-native";
import { MAX_CAPTION_LENGTH, photoInfoRows } from "@starkeep/photos-info";
import type { DataRecord, MetadataRow } from "@starkeep/protocol-primitives";
import { infoFields } from "../src/ui/info-fields";
import { PhotoInfoSheet } from "../src/ui/PhotoInfoSheet";
import { styles } from "../src/ui/theme";
import { photoRecord } from "./fixtures";

const ROW = {
  width: 4032,
  height: 3024,
  captured_at: "2026-10-19T14:03:00.000Z",
  camera_make: "Google",
  camera_model: "Pixel 5",
  orientation: 1,
} as unknown as MetadataRow;

/** The sheet's row labels, top to bottom. */
function labels(): string[] {
  return screen
    .UNSAFE_queryAllByType(Text)
    .filter((text) => text.props.style === styles.infoLabel)
    .map((text) => String(text.props.children));
}

function valueOf(label: string): string {
  const all = screen.UNSAFE_queryAllByType(Text);
  const at = all.findIndex((text) => text.props.children === label);
  return String(all[at + 1]!.props.children);
}

/** Lets the sheet's read resolve and render. */
async function settle() {
  await act(async () => undefined);
}

describe("the info sheet", () => {
  it("shows the shared rows for the metadata it read, then Type and Content hash", async () => {
    const record = photoRecord();
    const readInfo = jest.fn(async () => ROW);
    render(<PhotoInfoSheet record={record} readInfo={readInfo} onDelete={jest.fn(async () => undefined)} onClose={jest.fn()} />);
    await settle();

    expect(readInfo).toHaveBeenCalledWith(record);
    const shared = photoInfoRows(infoFields(record, ROW)).map((row) => row.label);
    // The metadata row reached the sheet, rather than the record alone.
    expect(shared).toEqual(expect.arrayContaining(["Dimensions", "Date taken", "Camera"]));
    expect(labels()).toEqual([...shared, "Type", "Content hash"]);
    expect(valueOf("Type")).toBe(record.type);
    expect(valueOf("Content hash")).toBe(record.contentHash);
  });

  it("leaves out Content hash for a record that has none", async () => {
    const record = photoRecord({ contentHash: null });
    render(<PhotoInfoSheet record={record} readInfo={async () => null} onDelete={jest.fn(async () => undefined)} onClose={jest.fn()} />);
    await settle();
    expect(labels()).not.toContain("Content hash");
    expect(labels().at(-1)).toBe("Type");
  });

  it("does not show a read that lands after the sheet moved to another record", async () => {
    const first = photoRecord();
    const second = photoRecord();
    let finishFirst: (row: MetadataRow) => void = () => undefined;
    const readInfo = jest.fn((record: DataRecord) =>
      record === first
        ? new Promise<MetadataRow>((done) => (finishFirst = done))
        : Promise.resolve(null),
    );
    const { rerender } = render(
      <PhotoInfoSheet record={first} readInfo={readInfo} onDelete={jest.fn(async () => undefined)} onClose={jest.fn()} />,
    );
    rerender(<PhotoInfoSheet record={second} readInfo={readInfo} onDelete={jest.fn(async () => undefined)} onClose={jest.fn()} />);
    await settle();

    await act(async () => finishFirst(ROW));
    expect(labels()).not.toContain("Camera");
    const shared = photoInfoRows(infoFields(second, null)).map((row) => row.label);
    expect(labels()).toEqual([...shared, "Type", "Content hash"]);
  });

  it("deletes only after the confirmation, closing the sheet first", async () => {
    const record = photoRecord();
    const calls: string[] = [];
    const onClose = jest.fn(() => calls.push("close"));
    const onDelete = jest.fn(async () => {
      calls.push("delete");
    });
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
    render(<PhotoInfoSheet record={record} readInfo={async () => null} onDelete={onDelete} onClose={onClose} />);
    await settle();

    fireEvent.press(screen.getByLabelText("Delete"));
    expect(onDelete).not.toHaveBeenCalled();

    const buttons = alert.mock.calls[0]![2]!;
    await act(async () => buttons.find((button) => button.text === "Delete")!.onPress!());
    expect(calls).toEqual(["close", "delete"]);
    expect(onDelete).toHaveBeenCalledWith(record);
    alert.mockRestore();
  });
});

describe("the caption in the info sheet", () => {
  function fakeCaptions(initial: string | null, blocked: string | null = null) {
    let stored = initial;
    return {
      get: jest.fn(async () => stored),
      set: jest.fn(async (_id: string, text: string) => {
        stored = text === "" ? null : text;
        return stored;
      }),
      editBlockedReason: jest.fn(() => blocked),
    };
  }

  function sheet(record: DataRecord, captions: ReturnType<typeof fakeCaptions>, onCaptionChange = jest.fn()) {
    return (
      <PhotoInfoSheet
        record={record}
        readInfo={async () => null}
        onDelete={jest.fn(async () => undefined)}
        captions={captions}
        onCaptionChange={onCaptionChange}
        onClose={jest.fn()}
      />
    );
  }

  it("shows the caption, and Edit caption opens a field prefilled with it that saves", async () => {
    const record = photoRecord();
    const captions = fakeCaptions("A cat");
    const onCaptionChange = jest.fn();
    render(sheet(record, captions, onCaptionChange));
    await settle();
    expect(captions.get).toHaveBeenCalledWith(record.id);
    expect(screen.getByText("A cat")).toBeTruthy();

    fireEvent.press(screen.getByLabelText("Edit caption"));
    const field = screen.getByLabelText("Caption");
    expect(field.props.value).toBe("A cat");

    fireEvent.changeText(field, "A sleeping cat");
    await act(async () => fireEvent.press(screen.getByLabelText("Save")));
    expect(captions.set).toHaveBeenCalledWith(record.id, "A sleeping cat");
    expect(onCaptionChange).toHaveBeenCalledWith(record.id, "A sleeping cat");
    expect(screen.queryByLabelText("Caption")).toBeNull();
    expect(screen.getByText("A sleeping cat")).toBeTruthy();
  });

  it("Cancel leaves the caption as it was", async () => {
    const captions = fakeCaptions("A cat");
    render(sheet(photoRecord(), captions));
    await settle();
    fireEvent.press(screen.getByLabelText("Edit caption"));
    fireEvent.changeText(screen.getByLabelText("Caption"), "Something else");
    fireEvent.press(screen.getByLabelText("Cancel"));
    expect(captions.set).not.toHaveBeenCalled();
    expect(screen.getByText("A cat")).toBeTruthy();
  });

  it("disables Edit caption until the Photos channel has pulled, and says why", async () => {
    const captions = fakeCaptions(null, "Captions can be edited once this phone has synced them.");
    render(sheet(photoRecord(), captions));
    await settle();
    const edit = screen.getByLabelText("Edit caption");
    expect(edit.props.accessibilityState).toEqual(expect.objectContaining({ disabled: true }));
    fireEvent.press(edit);
    expect(screen.queryByLabelText("Caption")).toBeNull();
    expect(screen.getByText("Captions can be edited once this phone has synced them.")).toBeTruthy();
  });

  it("says why a save failed and keeps the draft open", async () => {
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
    const record = photoRecord();
    const captions = fakeCaptions("A cat");
    captions.set.mockRejectedValueOnce(new Error("Captions can be edited once this phone has synced them."));
    const onCaptionChange = jest.fn();
    render(sheet(record, captions, onCaptionChange));
    await settle();

    fireEvent.press(screen.getByLabelText("Edit caption"));
    fireEvent.changeText(screen.getByLabelText("Caption"), "A sleeping cat");
    await act(async () => fireEvent.press(screen.getByLabelText("Save")));

    expect(alert).toHaveBeenCalledWith(
      "Could not save the caption",
      "Captions can be edited once this phone has synced them.",
    );
    expect(screen.getByLabelText("Caption").props.value).toBe("A sleeping cat");
    expect(onCaptionChange).not.toHaveBeenCalled();
    alert.mockRestore();
  });

  it("limits the field to the shared caption length", async () => {
    render(sheet(photoRecord(), fakeCaptions(null)));
    await settle();
    fireEvent.press(screen.getByLabelText("Edit caption"));
    expect(screen.getByLabelText("Caption").props.maxLength).toBe(MAX_CAPTION_LENGTH);
  });
});
