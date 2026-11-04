import { Bolt, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { encodeDeviceId } from "../api/client";
import { useDevices } from "../api/hooks";
import { DeviceKindIcon, KIND_LABEL } from "../components/DeviceKindIcon";
import { EmptyState } from "../components/EmptyState";
import { Skeleton } from "../components/Skeleton";
import { formatKwh, formatWatts } from "../lib/format";

export function Devices() {
  const devices = useDevices();
  const [search, setSearch] = useState("");
  const navigate = useNavigate();

  const filtered = useMemo(() => {
    const list = devices.data ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (d) => d.name.toLowerCase().includes(q) || (d.room ?? "").toLowerCase().includes(q) || d.device_id.toLowerCase().includes(q),
    );
  }, [devices.data, search]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <div className="relative w-full max-w-xs">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            data-testid="devices-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search devices"
            className="w-full rounded-md border border-border bg-surface py-1.5 pl-8 pr-3 text-sm text-text placeholder:text-text-muted focus:outline-none"
          />
        </div>
      </div>

      {devices.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={Bolt}
          title={devices.data && devices.data.length > 0 ? "No devices match that search." : "No devices yet."}
          detail={
            devices.data && devices.data.length > 0
              ? "Try a different name or room."
              : "A device appears here the first time it reports a reading."
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table data-testid="devices-table" className="w-full min-w-[720px] text-left text-sm">
            <thead className="bg-surface text-xs text-text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Room</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 text-right font-medium">Live</th>
                <th className="px-3 py-2 text-right font-medium">kWh today</th>
                <th className="px-3 py-2 text-right font-medium">Events today</th>
                <th className="px-3 py-2 text-right font-medium">Open alerts</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((d) => (
                <tr
                  key={d.device_id}
                  data-testid="device-row"
                  data-device-id={d.device_id}
                  tabIndex={0}
                  role="button"
                  onKeyDown={(e) => e.key === "Enter" && navigate(`/devices/${encodeDeviceId(d.device_id)}`)}
                  onClick={() => navigate(`/devices/${encodeDeviceId(d.device_id)}`)}
                  className="cursor-pointer border-t border-border bg-surface transition-colors hover:bg-surface-raised"
                >
                  <td className="px-3 py-2">
                    <span className="flex items-center gap-2 text-text">
                      <DeviceKindIcon kind={d.kind} />
                      {d.name}
                      <span className="text-xs text-text-muted">{KIND_LABEL[d.kind]}</span>
                    </span>
                  </td>
                  <td className="px-3 py-2 text-text-muted">{d.room ?? "No room set"}</td>
                  <td className="px-3 py-2">
                    <span className="flex items-center gap-1.5">
                      <span className={`h-1.5 w-1.5 rounded-full ${d.online ? "bg-trace" : "bg-critical"}`} aria-hidden />
                      <span className="text-text-muted">{d.online ? "Online" : "Offline"}</span>
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right font-mono-nums text-text">{formatWatts(d.watts)}</td>
                  <td className="px-3 py-2 text-right font-mono-nums text-text">{formatKwh(d.kwh_today)}</td>
                  <td className="px-3 py-2 text-right font-mono-nums text-text-muted">{d.events_today}</td>
                  <td className="px-3 py-2 text-right font-mono-nums">
                    <span className={d.open_alerts > 0 ? "text-warning" : "text-text-muted"}>{d.open_alerts}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
