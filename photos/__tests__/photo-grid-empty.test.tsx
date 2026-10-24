// @vitest-environment jsdom
/**
 * What an empty grid says. "No photos yet" is a claim about the library, so the
 * grid makes it only after a load has succeeded and found nothing. A first load
 * that failed knows nothing about the library, and used to make the claim.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PhotoGrid } from "../src/photos-ui/components/grid/photo-grid";

beforeAll(() => {
  globalThis.IntersectionObserver = class {
    observe(): void {}
    disconnect(): void {}
    unobserve(): void {}
  } as unknown as typeof IntersectionObserver;
});

afterEach(cleanup);

function grid(props: { loading: boolean; loaded: boolean }) {
  return render(
    <PhotoGrid images={[]} hasMore={false} onSelect={() => {}} onLoadMore={() => {}} {...props} />,
  );
}

describe("the empty grid", () => {
  it("says it is loading while the first load is in flight", () => {
    grid({ loading: true, loaded: false });
    expect(screen.queryByText(/No photos yet/)).toBeNull();
    expect(screen.getByText("Loading...")).toBeTruthy();
  });

  it("says it is loading, not empty, after a first load that failed", () => {
    grid({ loading: false, loaded: false });
    expect(screen.queryByText(/No photos yet/)).toBeNull();
    expect(screen.getByText("Loading...")).toBeTruthy();
  });

  it("says the library is empty once a load succeeded and found nothing", () => {
    grid({ loading: false, loaded: true });
    expect(screen.getByText(/No photos yet/)).toBeTruthy();
  });
});
