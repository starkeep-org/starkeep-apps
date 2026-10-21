/**
 * Opening a photograph from the grid.
 *
 * A tap waits up to 150 ms for the viewer's resolve, so the viewer opens on the
 * rung the stage wants rather than swapping to it a moment later. A slower
 * resolve opens on the tile's rung, and the resolution replaces it when it
 * lands. See `open` in `useLibraryViewer`.
 */
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { Image, type ImageProps } from "expo-image";
import { useLibraryViewer, type ViewerHost } from "../src/ui/LibraryGrid";
import type { LibraryItem } from "../src/library";
import { libraryItem, photoRecord } from "./fixtures";

let openItem: (item: LibraryItem) => void = () => undefined;

function Harness({ host, items }: { host: ViewerHost; items: readonly LibraryItem[] }) {
  const viewer = useLibraryViewer(host, items);
  openItem = viewer.open;
  return viewer.element;
}

/** A host whose resolve for each record lands after that record's delay. */
function hostResolvingAfter(delays: ReadonlyMap<string, number>) {
  const host: ViewerHost = {
    onFetch: jest.fn(async () => false),
    onFetchRendition: jest.fn(async () => false),
    onDeriveNow: jest.fn(async () => false),
    onOpenForViewer: jest.fn(
      (item: LibraryItem) =>
        new Promise<LibraryItem>((resolve) =>
          setTimeout(
            () => resolve(sharp(item)),
            delays.get(item.record.id) ?? 25,
          ),
        ),
    ),
    // Never answers: the Motion Photo probe is not what these tests are about.
    onOpenMotion: jest.fn(() => new Promise<null>(() => undefined)),
    onReadInfo: jest.fn(async () => null),
    onDelete: jest.fn(async () => undefined),
    onLoadMore: jest.fn(),
  };
  return host;
}

/** The rung a resolve finds for the viewer's stage. */
function sharp(item: LibraryItem): LibraryItem {
  return { ...item, uri: `file:///viewer/${item.record.id}.avif` };
}

/** Every `<Image>` URI on screen, in mount order. */
function shownUris(): (string | null)[] {
  return screen
    .UNSAFE_queryAllByType(Image)
    .map((image) => ((image.props as ImageProps).source as { uri: string } | null)?.uri ?? null);
}

async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe("opening a photograph", () => {
  it("opens on the resolved rung when the resolve lands within the wait", async () => {
    const photo = libraryItem(photoRecord());
    render(<Harness host={hostResolvingAfter(new Map([[photo.record.id, 25]]))} items={[photo]} />);

    act(() => openItem(photo));
    expect(shownUris()).toEqual([]);
    await advance(25);
    // No tile layer under it, so there was never a swap to see.
    expect(shownUris()).toEqual([sharp(photo).uri]);
  });

  it("opens on the tile's rung after the wait, and adds the resolution when it lands", async () => {
    const photo = libraryItem(photoRecord());
    render(<Harness host={hostResolvingAfter(new Map([[photo.record.id, 400]]))} items={[photo]} />);

    act(() => openItem(photo));
    await advance(149);
    expect(shownUris()).toEqual([]);
    await advance(1);
    expect(shownUris()).toEqual([photo.uri]);

    await advance(250);
    expect(shownUris()).toEqual([photo.uri, sharp(photo).uri]);
  });

  it("shows the second photograph when it is tapped before the first one's resolve lands", async () => {
    const first = libraryItem(photoRecord());
    const second = libraryItem(photoRecord());
    const host = hostResolvingAfter(
      new Map([
        [first.record.id, 400],
        [second.record.id, 25],
      ]),
    );
    render(<Harness host={host} items={[first, second]} />);

    act(() => openItem(first));
    await advance(10);
    act(() => openItem(second));
    await advance(500);

    // The open record is the one the info button describes.
    fireEvent.press(screen.getByLabelText("Photo info"));
    expect(host.onReadInfo).toHaveBeenLastCalledWith(second.record);
  });
});
