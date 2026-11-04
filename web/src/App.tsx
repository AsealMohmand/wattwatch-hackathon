import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Shell } from "./components/Shell";
import { ToastProvider } from "./components/Toast";
import { Alerts } from "./pages/Alerts";
import { Analytics } from "./pages/Analytics";
import { DeviceProfile } from "./pages/DeviceProfile";
import { Devices } from "./pages/Devices";
import { Live } from "./pages/Live";
import { NodeDetail } from "./pages/NodeDetail";
import { Nodes } from "./pages/Nodes";
import { NotFound } from "./pages/NotFound";
import { Overview } from "./pages/Overview";
import { Settings } from "./pages/Settings";
import { System } from "./pages/System";
import { Topology } from "./pages/Topology";
import { Assistant } from "./pages/ai/Assistant";
import { Insights } from "./pages/ai/Insights";
import { ModelLab } from "./pages/ai/ModelLab";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ToastProvider>
          <Routes>
            <Route element={<Shell />}>
              <Route index element={<Overview />} />
              <Route path="live" element={<Live />} />
              <Route path="devices" element={<Devices />} />
              <Route path="devices/:deviceId" element={<DeviceProfile />} />
              <Route path="nodes" element={<Nodes />} />
              <Route path="nodes/:nodeId" element={<NodeDetail />} />
              <Route path="alerts" element={<Alerts />} />
              <Route path="topology" element={<Topology />} />
              <Route path="analytics" element={<Analytics />} />
              <Route path="ai/assistant" element={<Assistant />} />
              <Route path="ai/insights" element={<Insights />} />
              <Route path="ai/model" element={<ModelLab />} />
              <Route path="detection" element={<Navigate to="/ai/model" replace />} />
              <Route path="system" element={<System />} />
              <Route path="settings" element={<Settings />} />
              <Route path="*" element={<NotFound />} />
            </Route>
          </Routes>
        </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

export default App;
