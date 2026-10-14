// Context
export { PhotoProvider, usePhotoContext } from "./context/photo-context";
export { PhotoUrlProvider, usePhotoUrls } from "./context/photo-url-context";
export {
  RenditionResolutionProvider,
  useRenditionResolutionCache,
  useRenditionPolicy,
  useMeasuredResolution,
} from "./context/rendition-resolution-context";

// Grid
export { PhotoGrid } from "./components/grid/photo-grid";
export { DateSection } from "./components/grid/date-section";
export { PhotoRows, displayAspect } from "./components/grid/photo-rows";
export { PhotoThumbnail } from "./components/grid/photo-thumbnail";
export { justifiedRows } from "./components/grid/justified-layout";
export type { JustifiedRow, JustifiedPlacement } from "./components/grid/justified-layout";

// Viewer
export { PhotoViewer } from "./components/viewer/photo-viewer";
export { PhotoInfoPanel } from "./components/viewer/photo-info-panel";

// Google import

// On-device vision (local target only — these render nothing when the routes
// answer 501, so the toolbar can mount them unconditionally)
export { VisionPanel } from "./components/vision/vision-panel";
export { PeopleView } from "./components/vision/people-view";
export { FaceOverlay } from "./components/vision/face-overlay";
