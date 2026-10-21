/**
 * The code half of the viewer's open-flicker fix.
 *
 * `expo-image` on Android reloads a view whose `source` or `placeholder` prop
 * changes, and a reload of a picture already on screen is a visible blackout.
 * These tests pin what the viewer hands each `<Image>`: the same objects for a
 * layer's whole life, and a new layer — never a re-pointed one — for a new rung.
 * Whether the screen actually flickers still needs a handset.
 */
import { act, render, screen } from "@testing-library/react-native";
import { StyleSheet } from "react-native";
import { Image, type ImageProps } from "expo-image";
import { LibraryViewer } from "../src/ui/LibraryViewer";
import type { LibraryItem } from "../src/library";
import { libraryItem, photoRecord } from "./fixtures";

function viewer(item: LibraryItem, resolved: ReadonlyMap<string, LibraryItem>, focused = false) {
  return (
    <LibraryViewer
      items={[item]}
      openId={item.record.id}
      resolved={resolved}
      stage={{ width: 390, height: 600 }}
      window={{ width: 390, height: 844 }}
      insets={{ top: 0, bottom: 0, left: 0, right: 0 }}
      landscape={false}
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
  return screen.UNSAFE_getAllByType(Image).map((image) => image.props as ImageProps);
}

const uriOf = (layer: ImageProps) => (layer.source as { uri: string } | null)?.uri ?? null;
const opacityOf = (layer: ImageProps) => StyleSheet.flatten(layer.style)?.opacity;

describe("the viewer's layer stack", () => {
  it("hands the first layer the same source and placeholder objects across re-renders", () => {
    const tile = libraryItem(photoRecord());
    const { rerender } = render(viewer(tile, new Map()));
    const [first] = layers();
    expect(first!.placeholder).toEqual({ thumbhash: tile.thumbHash });

    // The display re-renders the stage, and a focus toggle re-renders the frame.
    act(() => first!.onDisplay!());
    rerender(viewer(tile, new Map(), true));

    const [after] = layers();
    expect(after!.source).toBe(first!.source);
    expect(after!.placeholder).toBe(first!.placeholder);
  });

  it("mounts a new rung as a second layer, and collapses to it once it displays", () => {
    const tile = libraryItem(photoRecord());
    const sharp = { ...tile, uri: "file:///viewer/sharp.avif" };
    const { rerender } = render(viewer(tile, new Map()));
    const [first] = layers();

    rerender(viewer(tile, new Map([[tile.record.id, sharp]])));
    const [bottom, incoming] = layers();
    // The tile's layer is untouched: same objects, still opaque.
    expect(bottom!.source).toBe(first!.source);
    expect(bottom!.placeholder).toBe(first!.placeholder);
    expect(opacityOf(bottom!)).toBe(1);
    // The new rung decodes invisibly, over the picture already there.
    expect(uriOf(incoming!)).toBe(sharp.uri);
    expect(opacityOf(incoming!)).toBe(0);
    expect(incoming!.placeholder).toBeNull();

    act(() => incoming!.onDisplay!());
    const collapsed = layers();
    expect(collapsed.map(uriOf)).toEqual([sharp.uri]);
    expect(opacityOf(collapsed[0]!)).toBe(1);
  });

  it("ignores a display from a layer that a newer rung has already covered", () => {
    const tile = libraryItem(photoRecord());
    const medium = { ...tile, uri: "file:///viewer/medium.avif" };
    const large = { ...tile, uri: "file:///viewer/large.avif" };
    const { rerender } = render(viewer(tile, new Map()));
    rerender(viewer(tile, new Map([[tile.record.id, medium]])));
    rerender(viewer(tile, new Map([[tile.record.id, large]])));

    act(() => layers()[1]!.onDisplay!());
    expect(layers().map(uriOf)).toEqual([tile.uri, medium.uri, large.uri]);
  });

  it("mounts the first picture on a page that opened on its ThumbHash alone", () => {
    const blur = libraryItem(photoRecord(), { uri: null, bytesHere: false });
    const fetched = { ...blur, uri: "file:///viewer/fetched.avif", bytesHere: true };
    const { rerender } = render(viewer(blur, new Map()));
    expect(layers().map(uriOf)).toEqual([null]);

    rerender(viewer(blur, new Map([[blur.record.id, fetched]])));
    const [layer] = layers();
    expect(uriOf(layer!)).toBe(fetched.uri);
    expect(layer!.placeholder).toEqual({ thumbhash: blur.thumbHash });
  });
});
