import { useEffect, useRef } from "react";

const EVERY_MS = 60 * 1000;

/**
 * Keep a page's data current without anyone pressing reload: refresh when the
 * tab comes back into view or the window regains focus, and once a minute
 * while it is showing. A front desk leaves the dashboard open all day; "New
 * calls that need you will show up here" has to be true.
 *
 * @param {() => void} refresh  called to fetch again (should not show a loading state)
 */
export function useAutoRefresh(refresh) {
  const latest = useRef(refresh);
  useEffect(() => {
    latest.current = refresh;
  });

  useEffect(() => {
    const run = () => {
      if (document.visibilityState !== "hidden") latest.current();
    };
    document.addEventListener("visibilitychange", run);
    window.addEventListener("focus", run);
    const timer = setInterval(run, EVERY_MS);
    return () => {
      document.removeEventListener("visibilitychange", run);
      window.removeEventListener("focus", run);
      clearInterval(timer);
    };
  }, []);
}
