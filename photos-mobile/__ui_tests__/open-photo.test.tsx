/**
 * Opening a photograph from the grid.
 *
 * A tap opens the viewer at once, on the tile's rung. The
 * resolve for the rung the stage wants runs behind it, and its answer mounts as
 * a layer above. See `open` in `useLibraryViewer`.
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
  it("opens on the tap, on the tile's rung, before any resolve lands", async () => {
    const photo = libraryItem(photoRecord());
    render(<Harness host={hostResolvingAfter(new Map([[photo.record.id, 400]]))} items={[photo]} />);

    act(() => openItem(photo));
    expect(shownUris()).toEqual([photo.uri]);
  });

  it("replaces the tile's rung with the resolution when the tile's rung has not drawn yet", async () => {
    // One picture on open, not the tile's rung and then the sharper one a frame
    // or two later.
    const photo = libraryItem(photoRecord());
    render(<Harness host={hostResolvingAfter(new Map([[photo.record.id, 25]]))} items={[photo]} />);

    act(() => openItem(photo));
    await advance(25);
    expect(shownUris()).toEqual([sharp(photo).uri]);
  });

  it("mounts the resolution above the tile's rung once the tile's rung has drawn", async () => {
    const photo = libraryItem(photoRecord());
    render(<Harness host={hostResolvingAfter(new Map([[photo.record.id, 25]]))} items={[photo]} />);

    act(() => openItem(photo));
    const [tile] = screen.UNSAFE_queryAllByType(Image);
    act(() => (tile!.props as ImageProps).onDisplay!());
    await advance(25);
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
