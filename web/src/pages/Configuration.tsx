// The Configuration page in the SPA (PBI 175), as today's in src/http/views.ts shows it: every runtime setting with its
// value as the factory's WIP policy holds it now, then every env-backed setting the API started with, read-only and
// each needing a restart. An operator gets a form beside each runtime setting they can change, asking for the change's
// reason too (PBI 176), and a button to clear an active usage pause (PBI 178); a viewer gets no form at all.
import type { FormEvent } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ConfigSetting, ConfigurationProps } from "../api.ts";
import { H2, Message } from "./parts.tsx";

export { submitSetting } from "../forms.ts";

/** Whether a usage pause holds new starts back at `at`: a time still to come. One that has passed is no pause (PBI 178). */
const pauseActive = (value: string | null, at: Date) => value !== null && Date.parse(value) > at.getTime();

function Value({ v }: { v: string | null }) {
  return v === null ? <span className="text-muted-foreground">not set</span> : <>{v}</>;
}

function Note({ s }: { s: ConfigSetting }) {
  return s.note ? <span className="ml-2 text-muted-foreground">{s.note}</span> : null;
}

/**
 * Hands a setting's form to `onChange` with the fields it sends, as today's page posts them: `setting`, `value`, empty
 * for a clear, and `reason`. The browser sends nothing itself.
 */
function submitted(onChange: ConfigurationProps["onChange"]) {
  return (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const field = (name: string) => {
      const v = form.get(name);
      return typeof v === "string" ? v : "";
    };
    onChange?.(field("setting"), field("value"), field("reason"));
  };
}

function Change({ s, canOperate, at, onChange }: { s: ConfigSetting; canOperate: boolean; at: Date; onChange: ConfigurationProps["onChange"] }) {
  if (s.clearable && canOperate && pauseActive(s.value, at)) {
    return (
      <TableCell>
        <form className="flex flex-wrap items-center gap-2" onSubmit={submitted(onChange)}>
          <Input type="hidden" name="setting" value={s.key} />
          <Input type="hidden" name="value" value="" />
          <label htmlFor={`reason-${s.key}`}>Reason</label>
          <Input id={`reason-${s.key}`} name="reason" required className="w-48" />
          <Button type="submit" size="sm">Clear</Button>
        </form>
        <Note s={s} />
      </TableCell>
    );
  }
  if (!s.editable) return <TableCell className="text-muted-foreground">Set by the factory</TableCell>;
  if (!canOperate) return <TableCell><Note s={s} /></TableCell>;
  return (
    <TableCell>
      <form className="flex flex-wrap items-center gap-2" onSubmit={submitted(onChange)}>
        <Input type="hidden" name="setting" value={s.key} />
        <label htmlFor={`setting-${s.key}`}>New {s.label}</label>
        <Input id={`setting-${s.key}`} name="value" defaultValue={s.value ?? ""} className="w-32" />
        <label htmlFor={`reason-${s.key}`}>Reason</label>
        <Input id={`reason-${s.key}`} name="reason" required className="w-48" />
        <Button type="submit" size="sm">Change</Button>
      </form>
      <Note s={s} />
    </TableCell>
  );
}

function Head({ third }: { third: string }) {
  return (
    <TableHeader>
      <TableRow>{["Setting", "Value", third].map((h) => <TableHead key={h} scope="col">{h}</TableHead>)}</TableRow>
    </TableHeader>
  );
}

export function Configuration({ data, message, notice, onChange }: ConfigurationProps) {
  const at = data.at ? new Date(data.at) : new Date();
  return (
    <div>
      <h1 className="mb-3 text-2xl font-semibold">Configuration</h1>
      {notice && <Alert className="mb-3"><AlertDescription className="text-foreground">{notice}</AlertDescription></Alert>}
      <Message text={message} />
      <H2>Runtime settings</H2>
      <p className="text-muted-foreground">
        The factory's WIP policy, as it is now. A change takes effect on the scheduler's next turn, with no restart, unless its note says it does less.
      </p>
      <Table>
        <Head third={data.canOperate ? "Change" : "Notes"} />
        <TableBody>
          {data.runtime.map((s) => (
            <TableRow key={s.key}>
              <TableHead scope="row">{s.label}</TableHead>
              <TableCell><Value v={s.value} /></TableCell>
              <Change s={s} canOperate={data.canOperate} at={at} onChange={onChange} />
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <H2>Env-backed settings</H2>
      <p className="text-muted-foreground">
        What the API read from its environment at start. A change takes effect only when the factory restarts. Secrets never show here.
      </p>
      <Table>
        <Head third="Takes effect" />
        <TableBody>
          {data.env.map((s) => (
            <TableRow key={s.key}>
              <TableHead scope="row"><code>{s.label}</code></TableHead>
              <TableCell><Value v={s.value} /></TableCell>
              <TableCell>Needs a restart</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
