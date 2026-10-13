import BcsWorkspace from "./BcsWorkspace";
import StripsRegistryWorkspace from "./StripsRegistryWorkspace";
import StripsWorkspace from "./StripsWorkspace";
import SummaryApp from "./SummaryApp";

type AppMode = "summary" | "template" | "editor" | "strips" | "strips-registry";

const requestedMode = import.meta.env.VITE_BCS_MODE as AppMode | undefined;
const mode: AppMode = requestedMode === "template"
  || requestedMode === "editor"
  || requestedMode === "strips"
  || requestedMode === "strips-registry"
  ? requestedMode
  : "summary";

const titles: Record<AppMode, string> = {
  summary: "Зведення БЧС",
  template: "Шаблон БЧС",
  editor: "Редактор БЧС",
  strips: "Редактор позицій по смугах",
  "strips-registry": "Реєстр позицій та екіпажів",
};
document.title = titles[mode];

export default function App() {
  if (mode === "template") return <BcsWorkspace variant="template" />;
  if (mode === "editor") return <BcsWorkspace variant="editor" />;
  if (mode === "strips") return <StripsWorkspace />;
  if (mode === "strips-registry") return <StripsRegistryWorkspace />;
  return <SummaryApp />;
}
