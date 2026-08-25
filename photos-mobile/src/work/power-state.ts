import type { DeviceState } from "./job-graph";

export const BATTERY_STATE = {
  UNKNOWN: 0,
  UNPLUGGED: 1,
  CHARGING: 2,
  FULL: 3,
  NOT_CHARGING: 4,
} as const;

export interface PowerSnapshot {
  batteryLevel: number;
  batteryState: number;
  lowPowerMode: boolean;
}

export interface PowerStateDeps {
  getPowerState(): Promise<PowerSnapshot>;
}

const DEFAULT_DEPS: PowerStateDeps = {
  getPowerState: async () => (await import("expo-battery")).getPowerStateAsync(),
};

export async function readPowerState(
  base: Omit<DeviceState, "isCharging" | "batteryLevel" | "isLowPowerMode">,
  deps: PowerStateDeps = DEFAULT_DEPS,
): Promise<DeviceState> {
  try {
    const power = await deps.getPowerState();
    const charging =
      power.batteryState === BATTERY_STATE.CHARGING ||
      power.batteryState === BATTERY_STATE.FULL ||
      // Expo SDK 57 returns this state only when Android's explicit
      // BatteryManager.EXTRA_PLUGGED value is nonzero.
      power.batteryState === BATTERY_STATE.NOT_CHARGING;
    return {
      ...base,
      isCharging: charging,
      ...(power.batteryLevel >= 0 ? { batteryLevel: power.batteryLevel } : {}),
      isLowPowerMode: power.lowPowerMode,
    };
  } catch {
    return { ...base, isCharging: false, isLowPowerMode: true };
  }
}
