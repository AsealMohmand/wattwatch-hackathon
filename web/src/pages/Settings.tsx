import { Brain, Plus, SlidersHorizontal, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { AlertSeverity, Rule, RuleCreate, RuleKind } from "../api/client";
import {
  useCreateRule,
  useDeleteRule,
  useDevices,
  useLlm,
  usePatchRule,
  usePatchSettings,
  useRules,
  useSettings,
} from "../api/hooks";
import { EmptyState } from "../components/EmptyState";
import { Skeleton } from "../components/Skeleton";
import { useToast } from "../components/Toast";
import { formatDurationHint } from "../lib/format";

const RULE_KINDS: RuleKind[] = ["spike", "anomaly", "over_power", "offline", "daily_energy", "always_on", "hardware_limit"];
const SEVERITIES: AlertSeverity[] = ["info", "warning", "critical"];

const RULE_KIND_LABEL: Record<RuleKind, string> = {
  spike: "Power spike",
  anomaly: "Unusual pattern",
  over_power: "Sustained high draw",
  offline: "Node offline",
  daily_energy: "Daily energy",
  always_on: "Always-on load",
  hardware_limit: "Hardware limit",
};

const SEVERITY_LABEL: Record<AlertSeverity, string> = {
  info: "Info",
  warning: "Warning",
  critical: "Critical",
};

/** Rule kinds whose threshold is fixed by the detector itself (not user-set)
 * — the field reads "—" and is disabled rather than editable. */
const THRESHOLD_DISABLED: Record<RuleKind, boolean> = {
  spike: true,
  anomaly: true,
  over_power: false,
  offline: true,
  daily_energy: false,
  always_on: false,
  hardware_limit: true,
};

const THRESHOLD_UNIT: Partial<Record<RuleKind, string>> = {
  over_power: "W",
  always_on: "W",
  daily_energy: "kWh",
};

function useSavedToast() {
  const toast = useToast();
  return () => toast.push({ title: "Saved", severity: "info", href: "/settings" });
}

export function Settings() {
  const settings = useSettings();
  const patchSettings = usePatchSettings();
  const rules = useRules();
  const devices = useDevices();
  const deleteRule = useDeleteRule();
  const patchRule = usePatchRule();
  const pushSaved = useSavedToast();

  const llm = useLlm();

  const [siteName, setSiteName] = useState("");
  const [price, setPrice] = useState("");
  const [currency, setCurrency] = useState("");
  const [co2, setCo2] = useState("");
  const [volts, setVolts] = useState("");
  const [offlineAfter, setOfflineAfter] = useState("");
  const [showAdd, setShowAdd] = useState(false);

  useEffect(() => {
    if (!settings.data) return;
    setSiteName(settings.data.site_name);
    setPrice(String(settings.data.price_per_kwh));
    setCurrency(settings.data.currency);
    setCo2(String(settings.data.co2_kg_per_kwh));
    setVolts(String(settings.data.volts));
    setOfflineAfter(String(settings.data.offline_after_s));
  }, [settings.data]);

  function saveSettings(e: React.FormEvent) {
    e.preventDefault();
    patchSettings.mutate(
      {
        site_name: siteName.trim() || "Home",
        price_per_kwh: Number(price),
        currency,
        co2_kg_per_kwh: Number(co2),
        volts: Number(volts),
        offline_after_s: Number(offlineAfter),
      },
      { onSuccess: pushSaved },
    );
  }

  const deviceNameById = new Map((devices.data ?? []).map((d) => [d.device_id, d.name]));

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-3 rounded-md border border-border bg-surface p-4">
        <h2 className="text-sm font-medium text-text">Site</h2>
        {settings.isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : (
          <form data-testid="settings-form" onSubmit={saveSettings} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="flex flex-col gap-1 text-xs text-text-muted">
              Site name
              <input
                data-testid="settings-site-name"
                value={siteName}
                onChange={(e) => setSiteName(e.target.value)}
                className="rounded-md border border-border bg-bg px-2 py-1.5 text-sm text-text focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-text-muted">
              Price per kWh
              <input
                data-testid="settings-price"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                inputMode="decimal"
                className="rounded-md border border-border bg-bg px-2 py-1.5 text-sm font-mono-nums text-text focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-text-muted">
              Currency symbol
              <input
                data-testid="settings-currency"
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                className="rounded-md border border-border bg-bg px-2 py-1.5 text-sm text-text focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-text-muted">
              CO&#8322; per kWh
              <input
                data-testid="settings-co2"
                value={co2}
                onChange={(e) => setCo2(e.target.value)}
                inputMode="decimal"
                className="rounded-md border border-border bg-bg px-2 py-1.5 text-sm font-mono-nums text-text focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-text-muted">
              Voltage
              <input
                data-testid="settings-volts"
                value={volts}
                onChange={(e) => setVolts(e.target.value)}
                inputMode="decimal"
                className="rounded-md border border-border bg-bg px-2 py-1.5 text-sm font-mono-nums text-text focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-text-muted">
              Offline after (s)
              <input
                data-testid="settings-offline-after"
                value={offlineAfter}
                onChange={(e) => setOfflineAfter(e.target.value)}
                inputMode="numeric"
                className="rounded-md border border-border bg-bg px-2 py-1.5 text-sm font-mono-nums text-text focus:outline-none"
              />
            </label>
            <div className="sm:col-span-2 lg:col-span-4">
              <button
                type="submit"
                data-testid="settings-save"
                disabled={patchSettings.isPending}
                className="rounded-md bg-trace px-4 py-2 text-sm font-medium text-[#0b1612] transition-colors hover:opacity-90 disabled:opacity-50"
              >
                Save changes
              </button>
            </div>
          </form>
        )}
      </section>

      <section className="flex flex-col gap-3 rounded-md border border-border bg-surface p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-text">Alert rules</h2>
          <button
            type="button"
            data-testid="rule-add-open"
            onClick={() => setShowAdd(true)}
            className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-text transition-colors hover:bg-surface-raised"
          >
            <Plus size={13} />
            Add rule
          </button>
        </div>

        {rules.isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : rules.data && rules.data.length > 0 ? (
          <div className="overflow-x-auto">
            <table data-testid="rules-table" className="w-full min-w-[720px] text-left text-sm">
              <thead className="text-xs text-text-muted">
                <tr>
                  <th className="px-2 py-2 font-medium">Enabled</th>
                  <th className="px-2 py-2 font-medium">Name</th>
                  <th className="px-2 py-2 font-medium">Kind</th>
                  <th className="px-2 py-2 font-medium">Device</th>
                  <th className="px-2 py-2 text-right font-medium">Threshold</th>
                  <th className="px-2 py-2 text-right font-medium">Duration (s)</th>
                  <th className="px-2 py-2 font-medium">Severity</th>
                  <th className="px-2 py-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {rules.data.map((r) => (
                  <RuleRow key={r.id} rule={r} deviceName={r.device_id ? deviceNameById.get(r.device_id) ?? r.device_id : "All devices"} />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState icon={SlidersHorizontal} title="No alert rules yet." detail="Add one to start watching for spikes, offline devices or budget overruns." />
        )}
      </section>

      <section data-testid="settings-integrations" className="flex flex-col gap-3 rounded-md border border-border bg-surface p-4">
        <h2 className="text-sm font-medium text-text">Integrations</h2>
        {llm.isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : (
          <div className="flex flex-col gap-2 text-sm">
            <div className="flex items-center gap-2 text-text-muted">
              <Brain size={14} />
              <span className="text-text">Ollama</span>
              <span
                data-testid="settings-ollama-status"
                className={`ml-auto flex items-center gap-1.5 text-xs ${llm.data?.reachable ? "text-trace" : "text-critical"}`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${llm.data?.reachable ? "bg-trace" : "bg-critical"}`} aria-hidden />
                {llm.data?.reachable ? "Reachable" : "Unreachable"}
              </span>
            </div>
            <div className="grid grid-cols-1 gap-2 text-xs text-text-muted sm:grid-cols-3">
              <span>
                URL <span className="font-mono-nums text-text">http://127.0.0.1:11434</span>
              </span>
              <span>
                Model <span className="font-mono-nums text-text">{llm.data?.model ?? "—"}</span>
              </span>
              <span>
                Prompt <span className="font-mono-nums text-text">{llm.data?.prompt_version ?? "—"}</span>
              </span>
            </div>
          </div>
        )}
      </section>

      {showAdd && <AddRuleDialog onClose={() => setShowAdd(false)} />}
    </div>
  );

  function RuleRow({ rule, deviceName }: { rule: Rule; deviceName: string }) {
    const [threshold, setThreshold] = useState(rule.threshold != null ? String(rule.threshold) : "");
    const [duration, setDuration] = useState(String(rule.duration_s));
    const [severity, setSeverity] = useState<AlertSeverity>(rule.severity);
    const thresholdDisabled = THRESHOLD_DISABLED[rule.kind];
    const thresholdUnit = THRESHOLD_UNIT[rule.kind];

    return (
      <tr data-testid="rule-row" data-rule-id={rule.id} className="border-t border-border">
        <td className="px-2 py-2">
          <button
            type="button"
            role="switch"
            aria-checked={rule.enabled}
            data-testid="rule-enabled-toggle"
            onClick={() => patchRule.mutate({ id: rule.id, patch: { enabled: !rule.enabled } })}
            className={`h-5 w-9 rounded-full transition-colors ${rule.enabled ? "bg-trace" : "bg-surface-raised"}`}
          >
            <span className={`block h-4 w-4 rounded-full bg-surface transition-transform ${rule.enabled ? "translate-x-4" : "translate-x-0.5"}`} />
          </button>
        </td>
        <td className="px-2 py-2 text-text">{rule.name}</td>
        <td className="px-2 py-2 text-text-muted">{RULE_KIND_LABEL[rule.kind]}</td>
        <td className="px-2 py-2 text-text-muted">{deviceName}</td>
        <td className="px-2 py-2 text-right">
          {thresholdDisabled ? (
            <span className="text-xs text-text-muted">—</span>
          ) : (
            <span className="inline-flex items-center gap-1">
              <input
                data-testid="rule-threshold-input"
                value={threshold}
                onChange={(e) => setThreshold(e.target.value)}
                onBlur={() => patchRule.mutate({ id: rule.id, patch: { threshold: threshold.trim() === "" ? null : Number(threshold) } })}
                inputMode="decimal"
                className="w-16 rounded-md border border-border bg-bg px-2 py-1 text-right text-xs font-mono-nums text-text focus:outline-none"
              />
              {thresholdUnit && <span className="text-[10px] text-text-muted">{thresholdUnit}</span>}
            </span>
          )}
        </td>
        <td className="px-2 py-2 text-right">
          <div className="flex flex-col items-end gap-0.5">
            <input
              data-testid="rule-duration-input"
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
              onBlur={() => patchRule.mutate({ id: rule.id, patch: { duration_s: Number(duration) } })}
              inputMode="numeric"
              className="w-16 rounded-md border border-border bg-bg px-2 py-1 text-right text-xs font-mono-nums text-text focus:outline-none"
            />
            <span className="text-[10px] text-text-muted">{formatDurationHint(Number(duration) || 0)}</span>
          </div>
        </td>
        <td className="px-2 py-2">
          <select
            data-testid="rule-severity-select"
            value={severity}
            onChange={(e) => {
              const v = e.target.value as AlertSeverity;
              setSeverity(v);
              patchRule.mutate({ id: rule.id, patch: { severity: v } });
            }}
            className="rounded-md border border-border bg-bg px-1.5 py-1 text-xs text-text focus:outline-none"
          >
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {SEVERITY_LABEL[s]}
              </option>
            ))}
          </select>
        </td>
        <td className="px-2 py-2 text-right">
          <button
            type="button"
            data-testid="rule-delete"
            aria-label={`Delete ${rule.name}`}
            onClick={() => deleteRule.mutate(rule.id)}
            className="rounded-md p-1.5 text-text-muted transition-colors hover:text-critical hover:bg-critical-bg"
          >
            <Trash2 size={14} />
          </button>
        </td>
      </tr>
    );
  }
}

function AddRuleDialog({ onClose }: { onClose: () => void }) {
  const createRule = useCreateRule();
  const devices = useDevices();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<RuleKind>("spike");
  const [deviceId, setDeviceId] = useState<string>("");
  const [threshold, setThreshold] = useState("");
  const [duration, setDuration] = useState("0");
  const [severity, setSeverity] = useState<AlertSeverity>("warning");
  const thresholdDisabled = THRESHOLD_DISABLED[kind];
  const thresholdUnit = THRESHOLD_UNIT[kind];

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const rule: RuleCreate = {
      name: name.trim() || kind,
      kind,
      device_id: deviceId || null,
      threshold: threshold.trim() === "" ? null : Number(threshold),
      duration_s: Number(duration) || 0,
      severity,
      enabled: true,
    };
    createRule.mutate(rule, { onSuccess: onClose });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <form
        data-testid="rule-add"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        className="flex w-full max-w-md flex-col gap-3 rounded-md border border-border bg-surface p-5"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-text">Add rule</h2>
          <button type="button" aria-label="Close" onClick={onClose} className="rounded-md p-1 text-text-muted hover:bg-surface-raised">
            <X size={16} />
          </button>
        </div>
        <label className="flex flex-col gap-1 text-xs text-text-muted">
          Name
          <input data-testid="rule-add-name" value={name} onChange={(e) => setName(e.target.value)} className="rounded-md border border-border bg-bg px-2 py-1.5 text-sm text-text focus:outline-none" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-text-muted">
          Kind
          <select data-testid="rule-add-kind" value={kind} onChange={(e) => setKind(e.target.value as RuleKind)} className="rounded-md border border-border bg-bg px-2 py-1.5 text-sm text-text focus:outline-none">
            {RULE_KINDS.map((k) => (
              <option key={k} value={k}>
                {RULE_KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-text-muted">
          Device (leave blank for all)
          <select data-testid="rule-add-device" value={deviceId} onChange={(e) => setDeviceId(e.target.value)} className="rounded-md border border-border bg-bg px-2 py-1.5 text-sm text-text focus:outline-none">
            <option value="">All devices</option>
            {(devices.data ?? []).map((d) => (
              <option key={d.device_id} value={d.device_id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-xs text-text-muted">
            Threshold
            {thresholdDisabled ? (
              <span className="rounded-md border border-border bg-bg px-2 py-1.5 text-sm text-text-muted">—</span>
            ) : (
              <span className="flex items-center gap-1.5 rounded-md border border-border bg-bg px-2 py-1.5">
                <input
                  data-testid="rule-add-threshold"
                  value={threshold}
                  onChange={(e) => setThreshold(e.target.value)}
                  inputMode="decimal"
                  className="w-full min-w-0 bg-transparent text-sm font-mono-nums text-text focus:outline-none"
                />
                {thresholdUnit && <span className="shrink-0 text-xs text-text-muted">{thresholdUnit}</span>}
              </span>
            )}
          </label>
          <label className="flex flex-col gap-1 text-xs text-text-muted">
            Duration (s)
            <input data-testid="rule-add-duration" value={duration} onChange={(e) => setDuration(e.target.value)} inputMode="numeric" className="rounded-md border border-border bg-bg px-2 py-1.5 text-sm font-mono-nums text-text focus:outline-none" />
            <span className="text-[10px] text-text-muted">{formatDurationHint(Number(duration) || 0)}</span>
          </label>
        </div>
        <label className="flex flex-col gap-1 text-xs text-text-muted">
          Severity
          <select data-testid="rule-add-severity" value={severity} onChange={(e) => setSeverity(e.target.value as AlertSeverity)} className="rounded-md border border-border bg-bg px-2 py-1.5 text-sm text-text focus:outline-none">
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {SEVERITY_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          data-testid="rule-add-submit"
          disabled={createRule.isPending}
          className="mt-1 rounded-md bg-trace px-4 py-2 text-sm font-medium text-[#0b1612] transition-colors hover:opacity-90 disabled:opacity-50"
        >
          Add rule
        </button>
      </form>
    </div>
  );
}
