import {
  Coffee,
  Flame,
  HelpCircle,
  Lightbulb,
  Microwave,
  Monitor,
  Refrigerator,
  Tv,
  WashingMachine,
  Wind,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { DeviceKind } from "../api/client";

export const KIND_ICON: Record<DeviceKind, LucideIcon> = {
  unknown: HelpCircle,
  kettle: Coffee,
  heater: Flame,
  fridge: Refrigerator,
  computer: Monitor,
  lighting: Lightbulb,
  tv: Tv,
  washer: WashingMachine,
  dryer: Wind,
  microwave: Microwave,
  other: Zap,
};

export function DeviceKindIcon({ kind, size = 16 }: { kind: DeviceKind; size?: number }) {
  const Icon = KIND_ICON[kind] ?? HelpCircle;
  return <Icon size={size} aria-hidden data-testid="device-kind-icon" />;
}

export const KIND_LABEL: Record<DeviceKind, string> = {
  unknown: "Unknown",
  kettle: "Kettle",
  heater: "Heater",
  fridge: "Fridge",
  computer: "Computer",
  lighting: "Lighting",
  tv: "TV",
  washer: "Washer",
  dryer: "Dryer",
  microwave: "Microwave",
  other: "Other",
};

export const DEVICE_KINDS: DeviceKind[] = [
  "unknown",
  "kettle",
  "heater",
  "fridge",
  "computer",
  "lighting",
  "tv",
  "washer",
  "dryer",
  "microwave",
  "other",
];
