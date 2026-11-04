import { useOutletContext } from "react-router-dom";

export interface ShellOutletContext {
  setDeviceTitle: (title: string) => void;
}

export function useShellOutletContext() {
  return useOutletContext<ShellOutletContext>();
}
