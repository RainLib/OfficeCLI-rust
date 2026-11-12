import * as React from "react";

/** Hash routing keeps the console a single embedded page with real links. */
export function currentRoute(): string {
  const raw = window.location.hash.replace(/^#\/?/, "");
  return raw === "" ? "overview" : raw.split("?")[0];
}

export function useRoute(): [string, (route: string) => void] {
  const [route, setRoute] = React.useState(currentRoute);

  React.useEffect(() => {
    const onChange = () => setRoute(currentRoute());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  const navigate = React.useCallback((next: string) => {
    window.location.hash = `#/${next}`;
  }, []);

  return [route, navigate];
}
