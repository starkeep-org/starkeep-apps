/**
 * The bar over the grid: a menu button and the title, as the desktop toolbar
 * has. Everything that is not a photograph lives behind the menu.
 */

import { useState } from "react";
import { Modal, Pressable, Text, View } from "react-native";
import { MaterialIcons } from "@expo/vector-icons";
import { APP_BAR_HEIGHT, colors, styles } from "./theme";

export function AppBar({
  topInset,
  onOpenSettings,
}: {
  /** The status bar's height, which the bar sits below. */
  readonly topInset: number;
  readonly onOpenSettings: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <View style={{ paddingTop: topInset, backgroundColor: colors.background }}>
      <View style={styles.appBar}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Menu"
          onPress={() => setMenuOpen(true)}
          style={styles.iconButton}
        >
          <MaterialIcons name="menu" size={24} color={colors.heading} />
        </Pressable>
        <Text style={styles.appBarTitle}>Photos</Text>
      </View>

      {/* A transparent `Modal` rather than an absolutely positioned view, so a
          tap anywhere outside the menu closes it and Android back closes it
          too, with no touch handling of this app's own. */}
      <Modal
        visible={menuOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setMenuOpen(false)}
      >
        <Pressable style={styles.menuBackdrop} onPress={() => setMenuOpen(false)}>
          <View style={[styles.menu, { top: topInset + APP_BAR_HEIGHT - 8 }]}>
            <Pressable
              accessibilityRole="menuitem"
              onPress={() => {
                setMenuOpen(false);
                onOpenSettings();
              }}
              style={styles.menuItem}
            >
              <Text style={styles.menuItemLabel}>Settings</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}
