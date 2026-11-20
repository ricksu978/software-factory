// The no-access page: the shell shows it when the API answers 403 because the person isn't one of the factory's users.
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export function NoAccess({ text }: { text: string }) {
  return (
    <div className="min-h-screen bg-background p-6 text-foreground">
      <main className="mx-auto max-w-xl">
        <Alert variant="destructive">
          <AlertTitle>No access</AlertTitle>
          <AlertDescription>{text}</AlertDescription>
        </Alert>
      </main>
    </div>
  );
}
