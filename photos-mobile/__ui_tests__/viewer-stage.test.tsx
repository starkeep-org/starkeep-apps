/**
 * The viewer's stage never goes black.
 *
 * Every test drives the stage through `check`, which asserts one invariant
 * after each step: **once a picture is on screen, a picture stays on screen,
 * and no layer that has not drawn is opaque over another.** A layer's `source` also
 * never changes while it is mounted, because `expo-image` on Android reloads a
 * view whose source changes.
 *
 * The rules themselves are in `viewer-layers.ts` with tests of their own. These
 * tests cover the wiring: which callbacks move the stack, the frame between a
 * display and its collapse, the stall note, the still under a playing clip, and
 * the absence of any ThumbHash on this screen.
 * Whether the screen actually flickers still needs a handset.
 */
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { StyleSheet } from "react-native";
import { Image, type ImageProps } from "expo-image";
import type { DataRecord } from "@starkeep/protocol-primitives";
import { LibraryViewer } from "../src/ui/LibraryViewer";
import type { LibraryItem } from "../src/library";
import { libraryItem, photoRecord } from "./fixtures";

function viewer(
  item: LibraryItem,
  resolved: ReadonlyMap<string, LibraryItem>,
  { focused = false, landscape = false }: { focused?: boolean; landscape?: boolean } = {},
) {
  return (
    <LibraryViewer
      items={[item]}
      openId={item.record.id}
      resolved={resolved}
      stage={landscape ? { width: 600, height: 390 } : { width: 390, height: 600 }}
      window={landscape ? { width: 844, height: 390 } : { width: 390, height: 844 }}
      insets={{ top: 0, bottom: 0, left: 0, right: 0 }}
      landscape={landscape}
      focused={focused}
      busyId={null}
      onSettle={jest.fn()}
      onNearEnd={jest.fn()}
      onToggleFocus={jest.fn()}
      onPlay={jest.fn(async () => undefined)}
      // Never answers: the Motion Photo probe is not what these tests are about.
      onOpenMotion={jest.fn(() => new Promise<null>(() => undefined))}
      onReadInfo={jest.fn(async () => null)}
      onDelete={jest.fn(async () => undefined)}
      onClose={jest.fn()}
    />
  );
}

/** The stage's `<Image>` layers, bottom first. */
function layers(): ImageProps[] {
  return screen.UNSAFE_queryAllByType(Image).map((image) => image.props as ImageProps);
}

/** A layer's URI. */
function keyOf(layer: ImageProps): string {
  return (layer.source as { uri: string }).uri;
}

const keys = () => layers().map(keyOf);
const opacityOf = (layer: ImageProps) => StyleSheet.flatten(layer.style)?.opacity;
const layer = (key: string) => layers().find((candidate) => keyOf(candidate) === key)!;

const troubleNote = () => screen.queryByText("Having trouble loading this photo");

/** What the invariant remembers between steps. */
let visible = false;
let displayed = new Set<string>();
let sources = new Map<string, unknown>();

beforeEach(() => {
  jest.useFakeTimers();
  visible = false;
  displayed = new Set();
  sources = new Map();
});
afterEach(() => jest.useRealTimers());

/** The invariant. Called after every step of every test. */
function check() {
  const all = layers();
  const opaque = all.filter((candidate) => opacityOf(candidate) === 1);
  // The bottom layer covers nothing, so it may be opaque before it draws.
  for (const shown of opaque.filter((candidate) => candidate !== all[0])) {
    expect(displayed).toContain(keyOf(shown));
  }
  const now = opaque.some((candidate) => displayed.has(keyOf(candidate)));
  if (visible) expect(now).toBe(true);
  visible = now;
  for (const mounted of layers()) {
    const seen = sources.get(keyOf(mounted));
    if (seen) expect(mounted.source).toBe(seen);
    else sources.set(keyOf(mounted), mounted.source);
  }
}

/** A layer reports it has drawn. Its collapse waits for {@link nextFrame}. */
function display(key: string) {
  displayed.add(key);
  act(() => layer(key).onDisplay!());
  check();
}

function nextFrame() {
  act(() => jest.advanceTimersByTime(20));
  check();
}

describe("the viewer's stage", () => {
  it("opens on the tile's rung, then covers it with the stage's", () => {
    const tile = libraryItem(photoRecord());
    const sharp = { ...tile, uri: "file:///viewer/sharp.avif" };
    const { rerender } = render(viewer(tile, new Map()));
    check();
    expect(keys()).toEqual([tile.uri]);
    // Opaque before it draws: there is nothing beneath it to cover.
    expect(opacityOf(layer(tile.uri!))).toBe(1);

    display(tile.uri!);
    nextFrame();
    expect(opacityOf(layer(tile.uri!))).toBe(1);

    rerender(viewer(tile, new Map([[tile.record.id, sharp]])));
    check();
    expect(keys()).toEqual([tile.uri, sharp.uri]);
    expect(opacityOf(layer(sharp.uri))).toBe(0);

    display(sharp.uri);
    // Opaque now, and the tile's rung stays mounted beneath for one more frame.
    expect(keys()).toEqual([tile.uri, sharp.uri]);
    nextFrame();
    expect(keys()).toEqual([sharp.uri]);
  });

  it("never draws a ThumbHash, even for a page with no bytes here", () => {
    const blur = libraryItem(photoRecord(), { uri: null, bytesHere: false });
    const fetched = { ...blur, uri: "file:///viewer/fetched.avif", bytesHere: true };
    const { rerender } = render(viewer(blur, new Map()));
    check();
    expect(keys()).toEqual([]);
    expect(screen.getByText(/bytes are not on this device/)).toBeTruthy();

    rerender(viewer(blur, new Map([[blur.record.id, fetched]])));
    check();
    expect(keys()).toEqual([fetched.uri]);
    for (const mounted of layers()) expect(mounted.placeholder ?? null).toBeNull();
  });

  it("drops the tile's rung when the stage's rung draws first", () => {
    const tile = libraryItem(photoRecord());
    const sharp = { ...tile, uri: "file:///viewer/sharp.avif" };
    const { rerender } = render(viewer(tile, new Map()));
    rerender(viewer(tile, new Map([[tile.record.id, sharp]])));
    check();

    display(sharp.uri);
    nextFrame();
    expect(keys()).toEqual([sharp.uri]);
  });

  it("keeps the picture beneath a rung that will not decode", () => {
    const tile = libraryItem(photoRecord());
    const broken = { ...tile, uri: "file:///viewer/broken.avif" };
    const { rerender } = render(viewer(tile, new Map()));
    display(tile.uri!);
    nextFrame();
    rerender(viewer(tile, new Map([[tile.record.id, broken]])));
    check();

    act(() => layer(broken.uri).onError!({ error: "unreadable" }));
    check();
    expect(keys()).toEqual([tile.uri]);
    expect(troubleNote()).toBeNull();
  });

  it("says so at once when the only rung will not decode", () => {
    const tile = libraryItem(photoRecord());
    render(viewer(tile, new Map()));

    act(() => layer(tile.uri!).onError!({ error: "unreadable" }));
    check();
    expect(keys()).toEqual([]);
    expect(troubleNote()).not.toBeNull();
  });

  it("says so when a rung on this device has not drawn after two seconds", () => {
    const tile = libraryItem(photoRecord());
    render(viewer(tile, new Map()));

    act(() => jest.advanceTimersByTime(1900));
    expect(troubleNote()).toBeNull();
    act(() => jest.advanceTimersByTime(100));
    expect(troubleNote()).not.toBeNull();

    display(tile.uri!);
    expect(troubleNote()).toBeNull();
  });

  it("does not say so for a page waiting on a fetch", () => {
    // No rung here: the wait is a transfer, which has its own state.
    const blur = libraryItem(photoRecord(), { uri: null, bytesHere: false });
    render(viewer(blur, new Map()));
    act(() => jest.advanceTimersByTime(5000));
    expect(troubleNote()).toBeNull();
  });

  it("hands every layer the same source across re-renders", () => {
    const tile = libraryItem(photoRecord());
    const { rerender } = render(viewer(tile, new Map()));
    display(tile.uri!);
    nextFrame();
    // A focus toggle re-renders the frame. `check` holds the source identity.
    rerender(viewer(tile, new Map(), { focused: true }));
    check();
    expect(keys()).toEqual([tile.uri]);
  });

  it("keeps the page mounted across a rotation", () => {
    // A remount would build a new stage, with a new `source` object for the
    // same URI, which `check` catches.
    const tile = libraryItem(photoRecord());
    const { rerender } = render(viewer(tile, new Map()));
    display(tile.uri!);
    nextFrame();

    rerender(viewer(tile, new Map(), { landscape: true }));
    check();
    rerender(viewer(tile, new Map()));
    check();
    expect(keys()).toEqual([tile.uri]);
  });

  it("keeps a clip's poster mounted under the player", () => {
    const record = { ...photoRecord(), type: "video/mp4" } as DataRecord;
    const clip = libraryItem(record, { playbackUri: "file:///clip.mp4" });
    render(viewer(clip, new Map()));
    display(clip.uri!);
    nextFrame();

    fireEvent.press(screen.getByLabelText("Play"));
    check();
    // The player is up — its play button has gone — and the poster is still
    // the opaque layer beneath it.
    expect(screen.queryByLabelText("Play")).toBeNull();
    expect(keys()).toEqual([clip.uri]);
    expect(opacityOf(layer(clip.uri!))).toBe(1);
  });
});
