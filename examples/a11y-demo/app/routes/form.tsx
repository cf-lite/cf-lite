import { useRef, useState, type FormEvent } from "react";
import { useLang } from "../lang";

export const head = { title: "Form - cf-lite accessibility demo" };

export default function SignUp() {
  const { t } = useLang();
  const [errors, setErrors] = useState<{ name?: string; email?: string }>({});
  const [ok, setOk] = useState(false);
  const summary = useRef<HTMLDivElement>(null);
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const next: { name?: string; email?: string } = {};
    if (!String(f.get("name") ?? "").trim()) next.name = t.errName;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(f.get("email") ?? ""))) next.email = t.errEmail;
    setErrors(next); setOk(Object.keys(next).length === 0);
    if (Object.keys(next).length) queueMicrotask(() => summary.current?.focus());
  };
  const n = Object.keys(errors).length;
  return (
    <main id="main">
      <h1>{t.formTitle}</h1>
      {n > 0 && (
        <div ref={summary} role="alert" tabIndex={-1}>
          <h2>{n === 1 ? t.errOne : t.errSummary}</h2>
          <ul>{errors.name && <li><a href="#name">{errors.name}</a></li>}{errors.email && <li><a href="#email">{errors.email}</a></li>}</ul>
        </div>
      )}
      {ok && <p role="status">{t.okMsg}</p>}
      <form onSubmit={submit} noValidate>
        <p><label htmlFor="name">{t.name}</label><br />
          <input id="name" name="name" autoComplete="off" aria-invalid={!!errors.name} aria-describedby={errors.name ? "name-err" : undefined} />
          {errors.name && <span id="name-err"> {errors.name}</span>}</p>
        <p><label htmlFor="email">{t.email}</label><br />
          <input id="email" name="email" type="email" autoComplete="off" aria-invalid={!!errors.email} aria-describedby={errors.email ? "email-err" : undefined} />
          {errors.email && <span id="email-err"> {errors.email}</span>}</p>
        <button type="submit">{t.send}</button>
      </form>
    </main>
  );
}
