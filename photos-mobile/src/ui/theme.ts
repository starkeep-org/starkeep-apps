/**
 * One set of styles for the whole shell.
 *
 * Small enough to be a single file, and worth being one: two screens that drift
 * apart visually read as two apps, and this is the first thing anyone sees.
 */

import { StyleSheet } from "react-native";

export const colors = {
  background: "#111",
  surface: "#1a1a1a",
  text: "#eee",
  heading: "#fff",
  muted: "#888",
  border: "#2a2a2a",
  accent: "#4ade80",
  danger: "#f87171",
} as const;

export const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  content: { padding: 20, gap: 20 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },

  title: { color: colors.heading, fontSize: 28, fontWeight: "600" },
  subtitle: { color: colors.muted, fontSize: 14 },
  sectionTitle: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  section: { gap: 8 },
  body: { color: colors.text, fontSize: 15 },
  muted: { color: colors.muted, fontSize: 13 },
  mono: { color: "#ccc", fontSize: 12, fontFamily: "monospace" },
  error: { color: colors.danger, fontSize: 13 },

  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8,
    color: colors.text,
    fontSize: 16,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },

  button: {
    backgroundColor: colors.text,
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: "center",
  },
  buttonDisabled: { opacity: 0.4 },
  buttonLabel: { color: colors.background, fontSize: 16, fontWeight: "600" },
  linkLabel: { color: colors.muted, fontSize: 14 },

  // Three across, by percentage rather than a measured width: the tiles then
  // survive a rotation and a tablet without anyone measuring the screen.
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 2 },
  tile: {
    width: "32.8%",
    aspectRatio: 1,
    backgroundColor: colors.surface,
    justifyContent: "flex-end",
  },
  tileImage: { width: "100%", height: "100%" },
  tileBadge: {
    position: "absolute",
    right: 4,
    bottom: 3,
    color: "#fff",
    fontSize: 10,
    fontWeight: "600",
    // No backdrop, so this leans on the shadow to stay legible over a bright
    // frame — cheaper than a gradient and enough at this size.
    textShadowColor: "rgba(0,0,0,0.9)",
    textShadowRadius: 3,
  },

  row: { flexDirection: "row", gap: 10, alignItems: "flex-start" },
  rowText: { flex: 1, gap: 2 },
  badge: { fontSize: 11, fontWeight: "700", paddingTop: 3, width: 34 },
  ok: { color: colors.accent },
  bad: { color: colors.danger },
  /** For a check that failed without anything being wrong — see `Check.required`. */
  info: { color: colors.muted },
});
