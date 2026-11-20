// The SPA's page once the shell has found a session and a user (redesign step 8a). This step is the shell: Floor, run
// detail and the Phase 0 pages move here in later steps.
import { useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import type { Shell } from "./shell.ts";

export function App({ call }: { call: Shell["call"] }) {
  const [subject, setSubject] = useState<string>();

  useEffect(() => {
    let live = true;
    call("/auth/session")
      .then(async (r) => {
        if (r.ok && live) setSubject(((await r.json()) as { subject: string }).subject);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [call]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="flex items-center justify-between border-b px-6 py-3">
        <h1 className="text-lg font-semibold">Software factory</h1>
        {subject && <Badge variant="secondary">Signed in as {subject}</Badge>}
      </header>
      <main className="mx-auto max-w-3xl p-6">
        <Alert>
          <AlertTitle>The new dashboard is on its way</AlertTitle>
          <AlertDescription>
            Floor, run detail and the Phase 0 pages move here in later steps. Until then, today's dashboard has them.
          </AlertDescription>
        </Alert>
      </main>
    </div>
  );
}
