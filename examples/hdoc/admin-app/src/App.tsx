import { AppShell } from "@/components/AppShell";
import { ToastProvider } from "@/components/Toast";
import { useRoute } from "@/lib/router";
import { CatalogProvider } from "@/state/CatalogProvider";
import { DocumentsView } from "@/views/DocumentsView";
import { FontsView } from "@/views/FontsView";
import { OverviewView } from "@/views/OverviewView";
import { PreviewView } from "@/views/PreviewView";
import { ThemesView } from "@/views/ThemesView";
import { UploadView } from "@/views/UploadView";

function Routes({
  route,
  onNavigate,
}: {
  route: string;
  onNavigate: (route: string) => void;
}) {
  switch (route) {
    case "fonts":
      return <FontsView onNavigate={onNavigate} />;
    case "themes":
      return <ThemesView onNavigate={onNavigate} />;
    case "upload":
      return <UploadView onNavigate={onNavigate} />;
    case "preview":
      return <PreviewView />;
    case "documents":
      return <DocumentsView />;
    default:
      return <OverviewView onNavigate={onNavigate} />;
  }
}

export default function App() {
  const [route, navigate] = useRoute();

  return (
    <ToastProvider>
      <CatalogProvider>
        <AppShell route={route} onNavigate={navigate}>
          <Routes route={route} onNavigate={navigate} />
        </AppShell>
      </CatalogProvider>
    </ToastProvider>
  );
}
