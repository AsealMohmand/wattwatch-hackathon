// Qualitative palette for per-device chart series. Kept distinct from the
// severity palette (info/warning/critical) and from the two fixed accents
// (trace = live, copper = accumulated) so a legend never collides in
// meaning with a status color. Hues are spaced away from all five semantic
// colors in both themes (trace #0e9c7d/#39d9b0, copper #a6672a/#cc8b3c,
// info #2e6fa8/#5b9bd5, warning #92650a/#e3a712, critical #b23a2b/#e0503e)
// so a device series never reads as "this is a status".
export const CHART_PALETTE = ["#a3b33e", "#3fa9b8", "#6e82d1", "#9a6fd0", "#c97fc2", "#d98098"];

export function deviceColor(index: number): string {
  return CHART_PALETTE[index % CHART_PALETTE.length];
}
