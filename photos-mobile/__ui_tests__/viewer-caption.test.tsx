/**
 * The open photograph's caption in the viewer.
 *
 * The caption sits in the chrome, under the photograph, for the record on
 * screen only. A read that lands after a swipe must not caption the next
 * photograph, and a caption saved in the info sheet replaces the shown one.
 */
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { LibraryViewer } from "../src/ui/LibraryViewer";
import type { LibraryItem } from "../src/library";
import type { CaptionStore } from "../src/photos/captions";
import { libraryItem, photoRecord } from "./fixtures";

function viewer(items: LibraryItem[], openId: string, captions: CaptionStore) {
  return (
    <LibraryViewer
      items={items}
      openId={openId}
      resolved={new Map()}
      stage={{ width: 390, height: 600 }}
      window={{ width: 390, height: 844 }}
      insets={{ top: 0, bottom: 0, left: 0, right: 0 }}
      landscape={false}
      focused={false}
      busyId={null}
      onSettle={jest.fn()}
      onNearEnd={jest.fn()}
      onToggleFocus={jest.fn()}
      onPlay={jest.fn(async () => undefined)}
      onOpenMotion={jest.fn(() => new Promise<null>(() => undefined))}
      onReadInfo={jest.fn(async () => null)}
      onDelete={jest.fn(async () => undefined)}
      captions={captions}
      onClose={jest.fn()}
    />
  );
}

function captionsOf(byId: Record<string, string | null | Promise<string | null>>): CaptionStore {
  return {
    get: jest.fn(async (id: string) => byId[id] ?? null),
    set: jest.fn(async () => null),
    editBlockedReason: () => null,
  };
}

async function settle() {
  await act(async () => undefined);
}

describe("the viewer's caption", () => {
  it("shows the open photograph's caption", async () => {
    const item = libraryItem(photoRecord());
    render(viewer([item], item.record.id, captionsOf({ [item.record.id]: "A cat" })));
    await settle();
    expect(screen.getByText("A cat")).toBeTruthy();
  });

  it("shows nothing for a photograph with no caption", async () => {
    const item = libraryItem(photoRecord());
    render(viewer([item], item.record.id, captionsOf({})));
    await settle();
    expect(screen.queryByText("A cat")).toBeNull();
  });

  it("does not caption the next photograph with a read that lands after the swipe", async () => {
    const first = libraryItem(photoRecord());
    const second = libraryItem(photoRecord());
    let finishFirst: (text: string) => void = () => undefined;
    const captions = captionsOf({
      [first.record.id]: new Promise<string>((done) => (finishFirst = done)),
      [second.record.id]: null,
    });
    const { rerender } = render(viewer([first, second], first.record.id, captions));
    rerender(viewer([first, second], second.record.id, captions));
    await settle();
    await act(async () => finishFirst("A cat"));
    expect(screen.queryByText("A cat")).toBeNull();
  });

  it("shows a caption saved in the info sheet in place of the old one", async () => {
    const item = libraryItem(photoRecord());
    const captions: CaptionStore = {
      get: jest.fn(async () => "A cat"),
      set: jest.fn(async (_id: string, text: string) => text),
      editBlockedReason: () => null,
    };
    render(viewer([item], item.record.id, captions));
    await settle();

    fireEvent.press(screen.getByLabelText("Photo info"));
    await settle();
    fireEvent.press(screen.getByLabelText("Edit caption"));
    fireEvent.changeText(screen.getByLabelText("Caption"), "A sleeping cat");
    await act(async () => fireEvent.press(screen.getByLabelText("Save")));
    // Once in the sheet and once under the photograph.
    expect(screen.getAllByText("A sleeping cat")).toHaveLength(2);
    expect(screen.queryByText("A cat")).toBeNull();
  });
});
