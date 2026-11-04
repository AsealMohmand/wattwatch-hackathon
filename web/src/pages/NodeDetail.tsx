// F1-5 (detail): per-port panels (irms vs peak current, crest factor,
// sample rate vs the 860 SPS target, over-limit), telemetry charts for the
// last hour, and a "Mapped devices" table.
import { Cpu } from "lucide-react";
import { useEffect } from "react";
import { Link, useParams } from "react-router-dom";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { encodeDeviceId } from "../api/client";
import { useNode } from "../api/hooks";
import { EmptyState } from "../components/EmptyState";
import { Skeleton } from "../components/Skeleton";
import { useShellOutletContext } from "../lib/outletContext";
import { formatDuration, formatRelative, formatTime } from "../lib/format";

const TARGET_SPS = 860;

export function NodeDetail() {
  const { nodeId: encoded } = useParams<{ nodeId: string }>();
  const nodeId = encoded ? decodeURIComponent(encoded) : undefined;
  const node = useNode(nodeId);
  const { setDeviceTitle } = useShellOutletContext();

  useEffect(() => {
    if (node.data) setDeviceTitle(node.data.node_id);
  }, [node.data, setDeviceTitle]);

  if (node.isLoading) return <Skeleton className="h-96 w-full" />;
  if (!node.data) {
    return <EmptyState icon={Cpu} title="Node not found." detail="It may have been offline since before this node registry existed." />;
  }

  const n = node.data;

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-wrap items-center gap-4 rounded-md border border-border bg-surface p-4">
        <span className="flex items-center gap-2 text-lg font-medium text-text">
          <Cpu size={18} className="text-text-muted" />
          {n.node_id}
          <span className={`h-2 w-2 rounded-full ${n.online ? "bg-trace" : "bg-critical"}`} aria-hidden />
        </span>
        <div className="ml-auto flex flex-wrap gap-4 text-xs text-text-muted">
          <span>
            Firmware <span className="font-mono-nums text-text">{n.fw ?? "—"}</span>
          </span>
          <span>
            Boots <span className="font-mono-nums text-text">{n.boots}</span>
          </span>
          <span>
            Uptime <span className="font-mono-nums text-text">{n.uptime_ms != null ? formatDuration(n.uptime_ms / 1000) : "—"}</span>
          </span>
          <span>
            Last seen <span className="font-mono-nums text-text">{formatRelative(n.last_ts)}</span>
          </span>
        </div>
      </section>

      {n.ports.map((p) => {
        const sps = p.sample_rate_hz ?? p.n_samples;
        const spsShare = sps != null ? Math.min(1, sps / TARGET_SPS) : null;
        const portTelemetry = n.telemetry.filter((t) => t.port === p.port);
        return (
          <section key={p.port} data-testid="node-port-panel" data-port={p.port} className="flex flex-col gap-3 rounded-md border border-border bg-surface p-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium text-text">
                Port {p.port}
                {p.device_name && <span className="ml-2 text-xs text-text-muted">— {p.device_name}</span>}
              </h2>
              {p.over_limit && (
                <span data-testid="node-over-limit" className="rounded-md bg-critical-bg px-2 py-0.5 text-xs font-medium text-critical">
                  Over limit
                </span>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Metric label="Irms" value={p.irms_raw_a != null ? `${p.irms_raw_a.toFixed(2)} A` : "—"} />
              <Metric label="Peak" value={p.peak_raw_a != null ? `${p.peak_raw_a.toFixed(2)} A` : "—"} />
              <Metric
                label="Crest factor"
                value={p.crest_factor != null ? p.crest_factor.toFixed(2) : "—"}
                hint="~1.41 for a clean sine; higher means spiky loads"
              />
              <Metric
                label="Sample rate"
                value={sps != null ? `${sps.toFixed(0)} sps` : "—"}
                hint={spsShare != null ? `${(spsShare * 100).toFixed(0)}% of the 860 sps target` : undefined}
              />
            </div>

            {portTelemetry.length > 0 ? (
              <div data-testid="node-telemetry-chart" className="h-48 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={portTelemetry} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                    <CartesianGrid strokeDasharray="2 4" stroke="var(--color-border)" vertical={false} />
                    <XAxis dataKey="ts" tickFormatter={(ts: number) => formatTime(ts).slice(0, 5)} stroke="var(--color-text-muted)" fontSize={11} tickLine={false} axisLine={false} minTickGap={50} />
                    <YAxis stroke="var(--color-text-muted)" fontSize={11} tickLine={false} axisLine={false} width={36} />
                    <Tooltip
                      labelFormatter={(ts) => formatTime(Number(ts))}
                      formatter={(value, name) => [typeof value === "number" ? value.toFixed(2) : value, String(name)]}
                      contentStyle={{ background: "var(--color-surface-raised)", border: "1px solid var(--color-border)", borderRadius: 6, fontSize: 12 }}
                    />
                    <Area type="monotone" dataKey="irms_raw_a" name="Irms (A)" stroke="var(--color-trace)" fill="var(--color-trace)" fillOpacity={0.2} strokeWidth={1.5} isAnimationActive={false} dot={false} />
                    <Area type="monotone" dataKey="peak_raw_a" name="Peak (A)" stroke="var(--color-info)" fill="var(--color-info)" fillOpacity={0.12} strokeWidth={1.25} isAnimationActive={false} dot={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <EmptyState icon={Cpu} title="No telemetry in the last hour." detail="Firmware samples land here every 10th reading on this port." testId="node-telemetry-empty" />
            )}
          </section>
        );
      })}

      <section className="flex flex-col gap-2 rounded-md border border-border bg-surface p-4">
        <h2 className="text-sm font-medium text-text">Mapped devices</h2>
        {n.ports.some((p) => p.device_id) ? (
          <table data-testid="node-devices-table" className="w-full text-left text-sm">
            <thead className="text-xs text-text-muted">
              <tr>
                <th className="px-2 py-1.5 font-medium">Port</th>
                <th className="px-2 py-1.5 font-medium">Device</th>
                <th className="px-2 py-1.5 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {n.ports
                .filter((p) => p.device_id)
                .map((p) => (
                  <tr key={p.port} className="border-t border-border">
                    <td className="px-2 py-1.5 text-text-muted">{p.port}</td>
                    <td className="px-2 py-1.5">
                      <Link to={`/devices/${encodeDeviceId(p.device_id as string)}`} className="text-trace hover:underline">
                        {p.device_name ?? p.device_id}
                      </Link>
                    </td>
                    <td className="px-2 py-1.5 text-text-muted">{p.online ? "Online" : "Offline"}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        ) : (
          <EmptyState icon={Cpu} title="No devices mapped to this node yet." testId="node-devices-empty" />
        )}
      </section>
    </div>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-text-muted">{label}</span>
      <span className="font-mono-nums text-lg text-text">{value}</span>
      {hint && <span className="text-[11px] text-text-muted">{hint}</span>}
    </div>
  );
}
