import { useCallback, useRef, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { List, type RowComponentProps } from "react-window";

// The popup opened by billing.html: a login, then 5,000 invoices in a real react-window list. Rows are fetched
// in pages of 100 after a short delay, so a row that has just scrolled into view says "Loading…" first.
const TOTAL = 5000;
const PAGE = 100;
const ROW_HEIGHT = 44;

type Invoices = Record<number, string>;

function Row({
  index,
  style,
  invoices,
  pick,
}: RowComponentProps<{ invoices: Invoices; pick: (number: string) => void }>) {
  const number = invoices[index];
  return (
    <div style={{ ...style, display: "flex", alignItems: "center", padding: "0 12px", borderBottom: "1px solid #eee" }}>
      {number ? <button onClick={() => pick(number)}>Open invoice {number}</button> : <span>Loading…</span>}
    </div>
  );
}

function InvoiceList() {
  const [invoices, setInvoices] = useState<Invoices>({});
  const [picked, setPicked] = useState<string | null>(null);
  const requested = useRef(new Set<number>());
  const load = useCallback((start: number, stop: number) => {
    for (let page = Math.floor(start / PAGE); page <= Math.floor(stop / PAGE); page++) {
      if (requested.current.has(page)) continue;
      requested.current.add(page);
      void fetch(`/api/invoices?offset=${page * PAGE}&limit=${PAGE}`)
        .then((response) => response.json() as Promise<{ items: string[] }>)
        .then(({ items }) =>
          setInvoices((current) => ({
            ...current,
            ...Object.fromEntries(items.map((number, at) => [page * PAGE + at, number])),
          })),
        );
    }
  }, []);
  return (
    <main>
      <h1>Invoices</h1>
      <List
        aria-label="Invoices"
        style={{ height: 440, border: "1px solid #888" }}
        rowCount={TOTAL}
        rowHeight={ROW_HEIGHT}
        rowComponent={Row}
        rowProps={{ invoices, pick: setPicked }}
        onRowsRendered={({ startIndex, stopIndex }) => load(startIndex, stopIndex)}
      />
      {picked && (
        <p>
          <button
            onClick={() => {
              window.opener?.postMessage(`invoice:${picked}`, "*");
              window.close();
            }}
          >
            Confirm {picked}
          </button>
        </p>
      )}
    </main>
  );
}

function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [failed, setFailed] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: data.get("username"), password: data.get("password") }),
    });
    if (response.ok) onSignedIn();
    else setFailed(true);
  }
  return (
    <main>
      <h1>Sign in</h1>
      <form onSubmit={submit}>
        <p>
          <label>
            Username <input id="username" name="username" autoComplete="off" />
          </label>
        </p>
        <p>
          <label>
            Password <input id="password" name="password" type="password" autoComplete="off" />
          </label>
        </p>
        <button type="submit">Sign in</button>
        {failed && <p role="alert">Invalid username or password</p>}
      </form>
    </main>
  );
}

function App() {
  const [signedIn, setSignedIn] = useState(false);
  return signedIn ? <InvoiceList /> : <Login onSignedIn={() => setSignedIn(true)} />;
}

createRoot(document.getElementById("root")!).render(<App />);
