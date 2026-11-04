import { Link } from "react-router-dom";
import { Area, AreaChart, ResponsiveContainer } from "recharts";
import type { Device, ReadingPoint } from "../api/client";
import { encodeDeviceId } from "../api/client";
import { formatRelative, formatWatts } from "../lib/format";
import { DeviceKindIcon } from "./DeviceKindIcon";

export function DeviceCard({ device, spark }: { device: Device; spark?: ReadingPoint[] }) {
  const unnamed = device.name === device.device_id && device.kind === "unknown";
  return (
    <Link
      to={`/devices/${encodeDeviceId(device.device_id)}`}
      data-testid="device-card"
      data-device-id={device.device_id}
      className="flex flex-col gap-2 rounded-md border border-border bg-surface p-3 transition-colors hover:border-trace"
    >
      <div className="flex items-center justify-between">
        <div className="flex min-w-0 items-center gap-2 text-text">
          <DeviceKindIcon kind={device.kind} />
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-medium">{unnamed ? "Unnamed device" : device.name}</span>
            {unnamed && (
              <span data-testid="device-card-unnamed-id" className="truncate font-mono-nums text-[11px] text-text-muted">
                {device.device_id}
              </span>
            )}
          </div>
        </div>
        <span
          data-testid="device-online-dot"
          data-online={device.online}
          className={`h-2 w-2 shrink-0 rounded-full ${device.online ? "bg-trace" : "bg-critical"}`}
          aria-label={device.online ? "Online" : "Offline"}
        />
      </div>
      <div className="flex items-baseline justify-between">
        <span className="text-xs text-text-muted">{device.room ?? "No room set"}</span>
        <span className="font-mono-nums text-lg text-text">{device.online ? formatWatts(device.watts) : "—"}</span>
      </div>
      {!device.online && (
        <span data-testid="device-card-last-seen" className="text-xs text-text-muted">
          {device.last_ts != null
            ? `Last seen ${formatRelative(device.last_ts)} at ${formatWatts(device.last_watts)}`
            : "No readings yet."}
        </span>
      )}
      <div className="h-10 w-full">
        {spark && spark.length > 1 ? (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={spark} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
              <Area
                type="monotone"
                dataKey="avg_w"
                stroke="var(--color-trace)"
                fill="var(--color-trace)"
                fillOpacity={0.15}
                strokeWidth={1.5}
                isAnimationActive={false}
                dot={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div className="h-full w-full rounded bg-surface-raised/50" />
        )}
      </div>
    </Link>
  );
}
