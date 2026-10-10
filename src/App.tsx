import BcsWorkspace from "./BcsWorkspace";
import SummaryApp from "./SummaryApp";

type AppMode = "summary" | "template" | "editor";

const requestedMode = import.meta.env.VITE_BCS_MODE as AppMode | undefined;
const mode: AppMode = requestedMode === "template" || requestedMode === "editor"
  ? requestedMode
  : "summary";

export default function App() {
  if (mode === "template") return <BcsWorkspace variant="template" />;
  if (mode === "editor") return <BcsWorkspace variant="editor" />;
  return <SummaryApp />;
}
