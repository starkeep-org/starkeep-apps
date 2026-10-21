/**
 * The info sheet over the viewer.
 *
 * `info-fields.test.ts` covers the mapping and `photo-info-rows.test.ts` the
 * rows. These pin how the sheet puts them together: the metadata row it reads
 * for the open record, the shared rows built from it, then Type and Content
 * hash, and nothing from a read for a record the sheet has since moved past.
 * The last case pins Delete: confirmed, it closes the sheet and then deletes.
 */
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { Alert, Text } from "react-native";
import { photoInfoRows } from "@starkeep/photos-info";
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
